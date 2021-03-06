const Spotify = require('spotify-web-api-node');
const querystring = require('querystring');
const express = require('express');
const router = new express.Router();
const logger = require('../build/lib/logger')
const admin = require('firebase-admin');
const request = require('request');
const url = require('url')
const kue = require('./kue.js');
const refreshToken = require('./refreshToken.js')
const CLIENT_ID = process.env.SPOTIFYCLIENT;
const CLIENT_SECRET = process.env.SPOTIFYSECRET;
const REDIRECT_URI = process.env.redirect_uri || 'http://localhost:3000/callback';
const STATE_KEY = 'spotify_auth_state';
const scopes = ['user-read-private', 'user-read-email', 'user-read-playback-state' ,'user-read-currently-playing','user-modify-playback-state', 'streaming'];

// configure spotify
const spotifyApi = new Spotify({
    clientId: process.env.SPOTIFYCLIENT,
    clientSecret: process.env.SPOTIFYSECRET,
    redirectUri: REDIRECT_URI
});

/** Generates a random string containing numbers and letters of N characters */
const generateRandomString = N => (Math.random().toString(36)+Array(N).join('0')).slice(2, N+2);

/**
 * The /login endpoint
 * Redirect the client to the spotify authorize url, but first set that user's
 * state in the cookie.
 */

router.get('/login', (_, res) => {
    const state = generateRandomString(16);
    res.cookie(STATE_KEY, state);
    res.redirect(spotifyApi.createAuthorizeURL(scopes, state));
});

/**
 * The /callback endpoint - hit after the user logs in to spotifyApi
 * Verify that the state we put in the cookie matches the state in the query
 * parameter. Then, if all is good, redirect the user to the user page. If all
 * is not good, redirect the user to an error page
 */

router.get('/callback', (req, res) => {
    const { code, state } = req.query;
    const storedState = req.cookies ? req.cookies[STATE_KEY] : null;
    if (state === null || state !== storedState) {
        res.redirect('/#/error/state mismatch');
    } else {
        res.clearCookie(STATE_KEY);
        spotifyApi.authorizationCodeGrant(code).then(data => {
            const { expires_in, access_token, refresh_token } = data.body;

            spotifyApi.setAccessToken(access_token);
            spotifyApi.setRefreshToken(refresh_token);

            tokenExpirationEpoch = (new Date().getTime() / 1000) + data.body['expires_in'];
            logger.info('Retrieved token. It expires in ' + Math.floor(tokenExpirationEpoch - new Date().getTime() / 1000) + ' seconds!');

            spotifyApi.getMe().then(({ body }) => {
                const data = { 
                    'accessToken' : access_token, 
                    'refreshToken' : refresh_token,
                    'me' : body
                }
                res.cookie('spotify',data);
                res.redirect('/#/signup');
            });

        }).catch(err => {
            res.redirect('/#/error/invalid token');
        });
    }
});

router.post('/devices', (req,res) => {
    const {access_token,name,refresh_token} = req.body;
    if(access_token) {
        var devices = []
        var options = {
            url: 'https://api.spotify.com/v1/me/player/devices',
            headers: { 'Authorization': 'Bearer ' + access_token },
            json: true
        };
        request.get(options, (error, response, body) => {
            if(body.error == null && body.devices.length > 0){
                body.devices.forEach( (device) => {
                    devices.push({
                        name: device.name,
                        type: device.type,
                        id: device.id,
                    });
                });
                res.json({devices});
            }else if(body.error != undefined && body.error.message == 'The access token expired'){
                refreshToken(refresh_token,name,true)
                    .then( res => logger.info(res))
                    .catch( e=>{ logger.error(e) });
                res.json( {msg : body.error.message});
            }else{
                refreshToken(refresh_token,name,true)
                    .then( res => logger.info(res))
                    .catch( e=>{ logger.error(e) });
                res.json( {msg : "no devices"});
            }
        });
    }else
        res.json({msg : "access_token undefined"});
});

router.post('/search', (req, res, next) => {
    const {search,access_token,refresh_token,name}= req.body;
    logger.info("Searching for "+search)
    const headers = {
        'Accept': 'application/json',
        'Authorization': 'Bearer '+access_token
    };
    const options = {
        url: `https://api.spotify.com/v1/search?q=${search}&type=track`,
        headers: headers
    };
    request(options, (error, response, body) => {
        try { 
            let msg = JSON.parse(body)
            if (!msg.error) {
                res.json(msg);
            } else {
                logger.error(msg.error.message)
                refreshToken(refresh_token,name,false)
                    .then( res => logger.info(res))
                    .catch( e=>{ logger.error(e) });
                res.json(msg.error.message)
            }
        }catch (e){
            refreshToken(refresh_token,name,false)
                .then( res => logger.info(res))
                .catch( e=>{ logger.error(e) });
            res.json(e.msg)
        }
    })
});

router.post('/song-queue', (req, res) => {
    if(req.body == null) res.sendStatus(400)
    const {songs,device,refresh_token,name}= req.body;
    let redisUrl = url.parse(process.env.REDISCLOUD_URL||"redis://localhost:6379");
    const kueOptions = {};
    if(process.env.REDISCLOUD_URL) {
        kueOptions.redis = {
            port: parseInt(redisUrl.port),
            host: redisUrl.hostname
        };
        if(redisUrl.auth) {
            kueOptions.redis.auth = redisUrl.auth.split(':')[1];
        }
    }
    const jobs = kue.createQueue(kueOptions);

    songs.forEach( song => {
        logger.info("Adding ",song.name," To ",song.project.name)
        var songJob = jobs.create(song.project.name,{
            title: song.name,
            project: song.project.name,
            time: song.duration_ms,
            uri: song.uri,
            refresh_token: refresh_token,
            device: device,
            key: admin.database().ref(`projects/${song.project.name}/Songs`).push({song}).key,
        })
            .priority(song.project.votes)
            .save( err => {
                if(err) { 
                    logger.error(err.msg); 
                    res.json(err.msg)
                } else {
                    song.song_id = songJob.id;
                    admin.database().ref(`projects/${song.project.name}/Songs/${songJob.data.key}/song/song_id`).set(songJob.id)
                }
            })
    });
    res.sendStatus(204)
});

router.post('/user-playlist', (req, res) => {
    if(req.body == null) res.sendStatus(400)
    const {access_token,refresh_token,user,name}= req.body;
    const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer '+access_token
    };

    var options = {
        url: `https://api.spotify.com/v1/users/${user}/playlists?limit=20`,
        headers: headers
    };

    request(options, async (error, response, body) => {
        try { 
            let msg = JSON.parse(body)
            if (!msg.error) {
                res.json(msg);
            } else {
                logger.error(msg.error.message)
                refreshToken(refresh_token,name,false)
                    .then( res => logger.info(res))
                    .catch( e=>{ logger.error(e) });
                res.json({msg :msg.error.message})
            }
        }catch (e){
            refreshToken(refresh_token,name,false)
                .then( res => logger.info(res))
                .catch( e=>{ logger.error(e) });
            res.json({msg :e.msg})
        }
    })
})

router.post('/submit-playlist', (req, res) => {
    if(req.body == null) res.sendStatus(400)
    const {refresh_token, user, access_token ,name, id, submitedBy, projectname, device}= req.body;
    const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer '+access_token
    };
    var options = {
        url: `https://api.spotify.com/v1/users/${user}/playlists/${id}/tracks`,
        headers: headers
    };
    const kueOptions = {};
    let redisUrl = url.parse(process.env.REDISCLOUD_URL||"redis://localhost:6379");
    if(process.env.REDISCLOUD_URL) {
        kueOptions.redis = {
            port: parseInt(redisUrl.port),
            host: redisUrl.hostname
        };
        if(redisUrl.auth) {
            kueOptions.redis.auth = redisUrl.auth.split(':')[1];
        }
    }
    const jobs = kue.createQueue(kueOptions);

    const project = {
        name: projectname,
        votedUpBy: '',
        votedDownBy: '',
        votes: 0,
        submitedBy,
        author: user
    }

    request(options, (error, response, body) => {
        try { 
            let msg = JSON.parse(body)
            if (!msg.error) {
                msg.items.forEach( item =>{
                    const song = item.track;
                    song.project = project;
                    logger.info("Adding ",song.name," To ",song.project.name)
                    const songJob = jobs.create(song.project.name,{
                        title: song.name,
                        project: song.project.name,
                        time: song.duration_ms,
                        uri: song.uri,
                        refresh_token: refresh_token,
                        device: device,
                        key: admin.database().ref(`projects/${song.project.name}/Songs`).push({song}).key,
                    })
                    .priority(song.project.votes)
                    .save( err => {
                            if(err) { 
                                logger.error(err.msg); 
                                res.json(err.msg)
                            } else {
                                song.song_id = songJob.id;
                                admin.database().ref(`projects/${song.project.name}/Songs/${songJob.data.key}/song/song_id`).set(songJob.id)
                            }
                        })
                });
            res.sendStatus(204);
        } else {
            logger.error(msg.error.message)
            refreshToken(refresh_token,name,false)
                .then( res => logger.info(res))
                .catch( e=>{ logger.error(e) });
            res.json(msg.error.message)
        }
    }catch (e){
        logger.error(e.message)
        refreshToken(refresh_token,name,false)
            .then( res => logger.info(res))
            .catch( e=>{ logger.error(e) });
        res.json(e.msg)
    }
    })
})

module.exports = router;
