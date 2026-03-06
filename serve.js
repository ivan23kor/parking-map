const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const PORT = 8080;
const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const injectScript = API_KEY ? `
    <script>
    window.env = window.env || {};
    window.env.GOOGLE_MAPS_API_KEY = "${API_KEY}";
    </script>
` : '';

const server = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') filePath = './index.html';

    // Handle directory requests - serve index.html
    if (filePath.endsWith('/')) {
        filePath = filePath + 'index.html';
    } else if (path.extname(filePath) === '') {
        // URL without extension and without trailing slash
        const stat = fs.statSync(filePath, { throwIfNoEntry: false });
        if (stat && stat.isDirectory()) {
            filePath = filePath + '/index.html';
        }
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = MIME_TYPES[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not found');
            } else {
                res.writeHead(500);
                res.end('Server error: ' + error.code);
            }
            return;
        }

        // Inject env script into HTML files
        if (extname === '.html' && API_KEY) {
            content = content.toString().replace('</head>', injectScript + '</head>');
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    if (!API_KEY) console.warn('⚠️  GOOGLE_MAPS_API_KEY not set in environment');
});
