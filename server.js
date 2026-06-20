const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); // Added this to help find files

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Tell Express exactly where the public folder is
app.use(express.static(path.join(__dirname, 'public')));

// Explicitly send the index.html file when someone visits your link
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let currentVideo = 'dQw4w9WgXcQ'; // Default video

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.emit('video-change', currentVideo);

    socket.on('chat-message', (msg) => {
        io.emit('chat-message', msg); 
    });

    socket.on('video-change', (videoId) => {
        currentVideo = videoId;
        io.emit('video-change', videoId); 
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Hangout running on port ${PORT}`);
});
