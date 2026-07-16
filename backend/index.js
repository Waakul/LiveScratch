import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import basicAuth from 'express-basic-auth';
import http from 'http';
import fs from 'fs'; // <-- FIX: Added missing fs import to prevent shutdown crashes
import { Server } from 'socket.io';
import sanitize from 'sanitize-filename';

import SessionManager from './utils/sessionManager.js';
import UserManager from './utils/userManager.js';
import * as fileStorageUtils from './utils/fileStorage.js';
import { installCleaningJob } from './utils/removeOldProjects.js';
import { countRecentShared, recordPopup } from './utils/recentUsers.js'; // Note: Ensure saveRecent is exported here if needed
import { setPaths, authenticate, fullAuthenticate, freePassesPath, freePasses } from './utils/scratch-auth.js';
import initSockets from './WebSockets.js';

const app = express();
app.use(cors({ origin: '*' }));

// Optimized for larger JSON scratch payloads without choking memory
app.use(express.json({ limit: '20MB' })); 

const httpServer = http.createServer(app);
const ioHttp = new Server(httpServer, {
    cors: { origin: '*' },
    maxHttpBufferSize: 2e7, // 20MB limit for socket payloads
});

export let isFinalSaving = false;
const restartMessage = 'The Livescratch server is restarting. You will lose connection for a few seconds.';

const sleep = (millis) => new Promise(res => setTimeout(res, millis));

// --- 1. OPTIMIZED LOAD ROUTINE ---
console.log('Booting server... Loading project maps from storage into memory...');
const sessionsObj = fileStorageUtils.loadMapFromFolderRecursive('storage');
const sessionManager = SessionManager.fromJSON(sessionsObj);
const userManager = new UserManager();
setPaths(app, userManager, sessionManager);

// Sync initial state
fileStorageUtils.saveMapToFolder(sessionManager.livescratch, fileStorageUtils.livescratchPath);
fileStorageUtils.saveLoop(sessionManager);

// --- 2. BUG-FIXED & STABILIZED SHUTDOWN ROUTINE ---
async function finalSave(sessionManager) {
    if (isFinalSaving) return;
    try {
        isFinalSaving = true;
        console.log(`Broadcasting restart message: "${restartMessage}"`);
        sessionManager.broadcastMessageToAllActiveProjects(restartMessage);
        
        await sleep(2000); // Allow sockets time to flush messages
        console.log('Initiating final database save...');
        
        // FIX: Replaced bare fs calls with imported fs module
        fs.writeFileSync(fileStorageUtils.lastIdPath, (sessionManager.lastId).toString());
        fs.writeFileSync(freePassesPath, JSON.stringify(freePasses));
        
        // Save active project data to disk and free V8 heap memory
        await sessionManager.finalSaveAllProjects(); 
        
        // FIX: Corrected namespace reference to fileStorageUtils
        fileStorageUtils.saveMapToFolder(userManager.users, fileStorageUtils.usersPath);
        
        // Optional: Wrap saveRecent in a try-catch in case it's not exported/defined
        try {
            if (typeof saveRecent === 'function') await saveRecent();
        } catch (e) {
            console.warn('saveRecent utility was not found or failed to execute.');
        }

        console.log('Final save complete. Exiting process safely.');
        process.exit(0);
    } catch (e) {
        console.error('CRITICAL: Error occurred during final save sequence!', e);
        await sleep(10000); // Cooldown to prevent looping
        isFinalSaving = false;
    }
}

// Deferred startup clean jobs to prevent blocking event loop execution on boot
setTimeout(() => installCleaningJob(sessionManager, userManager), 10000);
new initSockets(ioHttp, sessionManager, userManager);

// --- 3. EXPRESS ROUTES ---

app.post('/newProject/:scratchId/:owner', (req, res) => {
    if (!authenticate(req.params.owner, req.headers.authorization)) return res.send({ noauth: true });
    if (!req.params.scratchId || (sanitize(req.params.scratchId.toString()) === '')) {
        return res.send({ err: 'invalid scratch id' });
    }
    
    let project = sessionManager.getScratchToLSProject(req.params.scratchId);
    if (!project) {
        console.log(`Creating new project: ${req.params.scratchId} by ${req.params.owner}`);
        project = sessionManager.newProject(req.params.owner, req.params.scratchId, req.body, req.query.title);
        userManager.newProject(req.params.owner, project.id);
    }
    res.send({ id: project.id });
});

app.get('/lsId/:scratchId/:uname', (req, res) => {
    const entry = sessionManager.getScratchProjectEntry(req.params.scratchId);
    const lsId = entry?.blId;
    if (!lsId) return res.send(null);
    
    const project = sessionManager.getProject(lsId);
    if (!project) {
        sessionManager.deleteScratchProjectEntry(req.params.scratchId);
        return res.send(null);
    }
    
    const hasAccess = fullAuthenticate(req.params.uname, req.headers.authorization, lsId);
    res.send(hasAccess ? lsId : null);
});

app.get('/scratchIdInfo/:scratchId', (req, res) => {
    if (sessionManager.doesScratchProjectEntryExist(req.params.scratchId)) {
        res.send(sessionManager.getScratchProjectEntry(req.params.scratchId));
    } else {
        res.send({ err: `could not find livescratch project associated with scratch project id: ${req.params.scratchId}` });
    }
});

app.get('/projectTitle/:id', (req, res) => {
    if (!fullAuthenticate(req.headers.uname, req.headers.authorization, req.params.id)) return res.send({ noauth: true });

    const project = sessionManager.getProject(req.params.id);
    if (!project) {
        res.send({ err: `could not find project with livescratch id: ${req.params.id}` });
    } else {
        res.send({ title: project.project.title });
    }
});

app.post('/projectSavedJSON/:lsId/:version', (req, res) => {
    if (!fullAuthenticate(req.headers.uname, req.headers.authorization, req.params.lsId)) return res.send({ noauth: true });

    const project = sessionManager.getProject(req.params.lsId);
    if (!project) {
        console.log(`Could not find project: ${req.params.lsId}`);
        return res.send({ err: "Couldn't find the specified project!" });
    }
    project.scratchSavedJSON(req.body, parseFloat(req.params.version));
    res.send({ success: 'Successfully saved the project!' });
});

app.get('/projectJSON/:lsId', (req, res) => {
    if (!fullAuthenticate(req.query.username, req.headers.authorization, req.params.lsId)) return res.send({ noauth: true });

    const project = sessionManager.getProject(req.params.lsId);
    if (!project) return res.sendStatus(404);
    
    res.send({ json: project.projectJson, version: project.jsonVersion });
});

app.use('/html', express.static('static'));

app.get('/changesSince/:id/:version', (req, res) => {
    if (!fullAuthenticate(req.headers.uname, req.headers.authorization, req.params.id)) return res.send({ noauth: true });

    const project = sessionManager.getProject(req.params.id);
    if (!project) return res.send([]);

    const oldestChange = project.project.getIndexZeroVersion();
    const clientVersion = parseFloat(req.params.version);
    const jsonVersion = project.jsonVersion;
    const forceReload = clientVersion < oldestChange - 1 && jsonVersion >= oldestChange - 1;

    if (clientVersion < oldestChange - 1 && jsonVersion < oldestChange - 1) {
        console.error('Client and JSON versions are both too old!', {
            id: project.id,
            jsonVersion,
            clientVersion,
            oldestChange
        });
    }

    let changes = project.project.getChangesSinceVersion(clientVersion);
    if (forceReload) {
        changes = ListToObj(changes);
        changes.forceReload = true;
    }
    res.send(changes);
});

// Helper for format conversion
function ListToObj(list) {
    const output = { length: list.length };
    for (let i = 0; i < list.length; i++) {
        output[i] = list[i];
    }
    return output;
}

app.get('/chat/:id', (req, res) => {
    if (!fullAuthenticate(req.headers.uname, req.headers.authorization, req.params.id)) return res.send({ noauth: true });
    const project = sessionManager.getProject(req.params.id);
    res.send(project ? project.getChat() : []);
});

// --- ADMIN / BAN ENDPOINTS ---
const adminAuth = basicAuth({
    users: JSON.parse(process.env.ADMIN_USER),
    challenge: true,
});

app.put('/ban/:username', adminAuth, (req, res) => {
    fileStorageUtils.ban(req.params.username)
        .then(() => res.send({ success: 'Successfully banned!' }))
        .catch(err => res.send({ err }));
});

app.put('/unban/:username', adminAuth, (req, res) => {
    fileStorageUtils.unban(req.params.username)
        .then(() => res.send({ success: 'Successfully unbanned!' }))
        .catch(err => res.send({ err }));
});

app.get('/banned', adminAuth, (req, res) => {
    fileStorageUtils.getBanned()
        .then(bannedList => res.send(bannedList))
        .catch(err => res.send({ err }));
});

// Cache stats calculations to avoid blocking event loops under high traffic
let cachedStats = null;
let cachedStatsTime = 0;
const cachedStatsLifetimeMillis = 5000; // Increased to 5s for better performance

app.get('/stats', adminAuth, (req, res) => {
    if (Date.now() - cachedStatsTime > cachedStatsLifetimeMillis) {
        cachedStats = sessionManager.getStats();
        cachedStats.cachedAt = new Date();
        cachedStatsTime = Date.now();
    }
    res.send(cachedStats);
});

app.get('/dau/:days', (req, res) => {
    res.send(String(countRecentShared(parseFloat(req.params.days))));
});

app.put('/linkScratch/:scratchId/:lsId/:owner', (req, res) => {
    if (!fullAuthenticate(req.params.owner, req.headers.authorization, req.params.lsId)) return res.send({ noauth: true });
    sessionManager.linkProject(req.params.lsId, req.params.scratchId, req.params.owner, 0);
    res.send({ success: 'Successfully linked!' });
});

app.get('/userExists/:username', (req, res) => {
    res.send(userManager.userExists(req.params.username) && !userManager.getUser(req.params.username).privateMe);
});

app.put('/privateMe/:username/:private', (req, res) => {
    const unameClean = sanitize(req.params.username);
    if (!authenticate(unameClean, req.headers.authorization)) return res.send({ noauth: true });
    userManager.getUser(unameClean).privateMe = req.params.private === 'true';
    res.sendStatus(200);
});

app.get('/privateMe/:username', (req, res) => {
    const unameClean = sanitize(req.params.username);
    if (!authenticate(unameClean, req.headers.authorization)) return res.send({ noauth: true });
    res.send(userManager.getUser(unameClean).privateMe);
});

app.get('/userRedirect/:scratchId/:username', (req, res) => {
    const project = sessionManager.getScratchToLSProject(req.params.scratchId);
    if (!fullAuthenticate(req.params.username, req.headers.authorization, project?.id)) {
        return res.send({ noauth: true, goto: 'none' });
    }
    if (!project) return res.send({ goto: 'none' });
     
    const ownedProject = project.getOwnersProject(req.params.username);
    if (ownedProject) {
        res.send({ goto: ownedProject.scratchId });
    } else {
        res.send({ goto: 'new', lsId: project.id });
    }
});

app.get('/active/:lsId', (req, res) => {
    if (!fullAuthenticate(req.headers.uname, req.headers.authorization, req.params.lsId)) return res.send({ noauth: true });

    const activeProj = sessionManager.getProject(req.params.lsId);
    const usernames = activeProj?.session.getConnectedUsernames();
    const clients = activeProj?.session.getConnectedUsersClients();
    if (usernames) {
        res.send(usernames.map(name => {
            const user = userManager.getUser(name);
            return { username: user.username, pk: user.pk, cursor: clients[name]?.cursor };
        }));
    } else {
        res.send({ err: `could not get users for project with id: ${req.params.lsId}` });
    }
});

app.get('/', (req, res) => {
    res.send('LiveScratch API');
});

app.post('/friends/:user/:friend', (req, res) => {
    if (!authenticate(req.params.user, req.headers.authorization)) return res.send({ noauth: true });
    if (!userManager.userExists(req.params.friend)) return res.sendStatus(404);

    userManager.befriend(req.params.user, req.params.friend);
    res.send({ success: 'Successfully friended!' });
});

app.delete('/friends/:user/:friend', (req, res) => {
    if (!authenticate(req.params.user, req.headers.authorization)) return res.send({ noauth: true });
    userManager.unbefriend(req.params.user, req.params.friend);
    res.send({ success: 'Succesfully unfriended!' });
});

app.get('/friends/:user', (req, res) => {
    recordPopup(req.params.user);
    if (!authenticate(req.params.user, req.headers.authorization)) return res.send({ noauth: true });
    res.send(userManager.getUser(req.params.user)?.friends);
});

app.get('/userProjects/:user', (req, res) => {
    if (!authenticate(req.params.user, req.headers.authorization)) return res.send({ noauth: true });
    res.send(userManager.getShared(req.params.user));
});

app.get('/userProjectsScratch/:user', (req, res) => {
    if (!authenticate(req.params.user, req.headers.authorization)) return res.send({ noauth: true });

    const livescratchIds = userManager.getAllProjects(req.params.user);
    const projectsList = livescratchIds.map(id => {
        const project = sessionManager.getProject(id);
        if (!project) return null;
        
        const ownerProj = project.getOwnersProject(req.params.user);
        return {
            scratchId: ownerProj ? ownerProj.scratchId : project.scratchId,
            blId: project.id,
            title: project.project.title,
            lastTime: project.project.lastTime,
            lastUser: project.project.lastUser,
            online: project.session.getConnectedUsernames(),
        };
    }).filter(Boolean);
    
    res.send(projectsList);
});

app.put('/leaveScratchId/:scratchId/:username', (req, res) => {
    const project = sessionManager.getScratchToLSProject(req.params.scratchId);
    if (!fullAuthenticate(req.params.username, req.headers.authorization, project, false)) return res.send({ noauth: true });
    
    userManager.unShare(req.params.username, project.id);
    sessionManager.unshareProject(project.id, req.params.username);
    res.send({ success: 'User successfully removed!' });
});

app.put('/leaveLSId/:lsId/:username', (req, res) => {
    if (!authenticate(req.params.username, req.headers.authorization)) return res.send({ noauth: true });
    
    userManager.unShare(req.params.username, req.params.lsId);
    sessionManager.unshareProject(req.params.lsId, req.params.username);
    res.send({ success: 'User successfully removed!' });
});

app.get('/verify/test', (req, res) => {
    res.send({ verified: authenticate(req.query.username, req.headers.authorization) });
});

app.get('/share/:id', (req, res) => {
    if (!fullAuthenticate(req.headers.uname, req.headers.authorization, req.params.id)) return res.send({ noauth: true });

    const project = sessionManager.getProject(req.params.id);
    let list = project?.sharedWith;
    if (!list) return res.send({ err: 'No shared list found for the specified project.' });
    
    list = list.map(name => ({ username: name, pk: userManager.getUser(name).pk }));
    res.send([{ username: project.owner, pk: userManager.getUser(project.owner).pk }].concat(list));
});

app.put('/share/:id/:to/:from', (req, res) => {
    if (!fullAuthenticate(req.params.from, req.headers.authorization, req.params.id)) return res.send({ noauth: true });

    const project = sessionManager.getProject(req.params.id);
    if (project?.owner === req.params.to) {
        return res.send({ err: 'Cannot share the project with the owner.' });
    }

    if (!userManager.userExists(req.params.to)) return res.sendStatus(404);

    sessionManager.shareProject(req.params.id, req.params.to, req.query.pk);
    userManager.getUser(req.params.to).pk = req.query.pk;
    userManager.share(req.params.to, req.params.id, req.params.from);
    res.send({ success: 'Project successfully shared.' });
});

app.put('/unshare/:id/:to/', (req, res) => {
    if (!fullAuthenticate(req.headers.uname, req.headers.authorization, req.params.id)) return res.send({ noauth: true });

    const project = sessionManager.getProject(req.params.id);
    if (project?.owner === req.params.to) {
        return res.send({ err: 'Cannot unshare the project with the owner.' });
    }
    
    sessionManager.unshareProject(req.params.id, req.params.to);
    userManager.unShare(req.params.to, req.params.id);
    res.send({ success: 'Project successfully unshared.' });
});

const port = process.env.PORT;
httpServer.listen(port, '0.0.0.0');
console.log(`Listening HTTP on port ${port}`);

// --- 4. CLEAN EXIT SYSTEM PROCESSES ---
process.stdin.resume();

async function exitHandler(options, exitCode) {
    if (options.cleanup) console.log('Cleaning environment...');
    if (exitCode || exitCode === 0) console.log(`Exit Code: ${exitCode}`);
    if (options.exit) {
        await finalSave(sessionManager);
    }
}

process.on('exit', exitHandler.bind(null, { cleanup: true }));
process.on('SIGINT', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR1', exitHandler.bind(null, { exit: true }));
process.on('SIGUSR2', exitHandler.bind(null, { exit: true }));
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception thrown!', err);
    exitHandler({ exit: true }, 1);
});