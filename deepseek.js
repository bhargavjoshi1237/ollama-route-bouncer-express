import fs from 'fs';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import readline from 'readline';
import path from 'path';
import express from 'express';
import bodyParser from 'body-parser';

// Add stealth plugin
puppeteer.use(StealthPlugin());

const PROFILE_PATH = path.join(process.cwd(), "deepseek-profiles.txt");

// Helper to read file or return empty string
function readFileOrEmpty(path) {
    try {
        return fs.readFileSync(path, 'utf8');
    } catch {
        return '';
    }
}

// Parse storage file as either JSON or tab-separated key/value pairs
function parseStorageFile(path) {
    const raw = readFileOrEmpty(path);
    if (!raw.trim()) return {};
    // Try JSON first
    try {
        return JSON.parse(raw);
    } catch {}
    // Parse tab-separated key/value pairs
    const obj = {};
    raw.split('\n').forEach(line => {
        line = line.trim();
        if (!line) return;
        const [key, ...rest] = line.split('\t');
        if (!key || rest.length === 0) return;
        let value = rest.join('\t');
        // Try to keep value as string, but if it's JSON, keep as string
        obj[key] = value;
    });
    return obj;
}

// Parse cookies from tab-separated format
function parseCookiesFile(path) {
    const raw = readFileOrEmpty(path);
    if (!raw.trim()) return [];
    const cookies = [];
    raw.split('\n').forEach(line => {
        line = line.trim();
        if (!line) return;
        // Split by tab
        const parts = line.split('\t');
        // Minimum: name, value, domain, path
        if (parts.length < 4) return;
        const [
            name, value, domain, path, 
            expires, // ISO string or "Session"
            // skip size
            httpOnly, secure, sameSite,
            // skip priorityURL, hostOnly, priority
        ] = parts;
        const cookie = {
            name: name,
            value: value,
            domain: domain,
            path: path
        };
        // Expires
        if (expires && expires !== 'Session') {
            const ts = Date.parse(expires);
            if (!isNaN(ts)) cookie.expires = Math.floor(ts / 1000);
        }
        // httpOnly
        if (httpOnly && httpOnly.trim() === '✓') cookie.httpOnly = true;
        // secure
        if (secure && secure.trim() === '✓') cookie.secure = true;
        // sameSite
        if (sameSite) {
            if (sameSite === 'Lax' || sameSite === 'Strict' || sameSite === 'None') {
                cookie.sameSite = sameSite;
            }
        }
        cookies.push(cookie);
    });
    return cookies;
}

// Parse headers from tab-separated format
function parseHeadersFile(path) {
    const raw = readFileOrEmpty(path);
    if (!raw.trim()) return {};
    const headers = {};
    raw.split('\n').forEach(line => {
        line = line.trim();
        if (!line) return;
        const [key, ...rest] = line.split('\t');
        if (!key || rest.length === 0) return;
        headers[key] = rest.join('\t');
    });
    return headers;
}

// Save profile to file
function saveProfile(profile) {
    fs.appendFileSync(PROFILE_PATH, JSON.stringify(profile) + "\n");
}

// Load profiles from file
function loadProfiles() {
    if (!fs.existsSync(PROFILE_PATH)) return [];
    const lines = fs.readFileSync(PROFILE_PATH, "utf-8").split("\n").filter(Boolean);
    return lines.map(line => {
        try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
}

// Prompt user for input
function promptUser(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(query, ans => { rl.close(); resolve(ans); }));
}

// Ensure txt files exist for user to paste data
['cookies.txt', 'localstorage.txt', 'sessionstorage.txt', 'headers.txt'].forEach(filename => {
    if (!fs.existsSync(filename)) {
        fs.writeFileSync(filename, '', 'utf8');
    }
});

(async () => {
    // Check if we have info in the txt files
    let cookiesRaw = readFileOrEmpty('cookies.txt').trim();
    let localStorageRaw = readFileOrEmpty('localstorage.txt').trim();
    let sessionStorageRaw = readFileOrEmpty('sessionstorage.txt').trim();

    // If any file is empty, prompt user for setup
    if (!cookiesRaw || !localStorageRaw || !sessionStorageRaw) {
        console.log("DeepSeek Setup: Some required files are empty.");
        console.log("Please provide your cf_clearance cookie value (to avoid captchas):");
        const cfClear = await promptUser("Paste your cf_clearance cookie value: ");
        // Write cf_clearance to cookies.txt in tab-separated format
        fs.writeFileSync('cookies.txt', `cf_clearance\t${cfClear}\t.deepseek.com\t/\tSession\t\t✓\t✓\tNone\t\t\t\n`, 'utf8');
        console.log("Launching browser for you to login to DeepSeek...");
        const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        // Set cf_clearance cookie
        await page.setCookie({
            name: 'cf_clearance',
            value: cfClear,
            domain: '.deepseek.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None'
        });
        await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded' });
        console.log("Please login in the browser window, then press Enter here to continue...");
        await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', () => resolve()); });
        // Dump cookies
        const cookiesDump = await page.cookies();
        fs.writeFileSync('cookies.txt', cookiesDump.map(c =>
            [
                c.name,
                c.value,
                c.domain,
                c.path,
                c.expires ? new Date(c.expires * 1000).toISOString() : 'Session',
                '',
                c.httpOnly ? '✓' : '',
                c.secure ? '✓' : '',
                c.sameSite || '',
                '', '', ''
            ].join('\t')
        ).join('\n'), 'utf8');
        // Dump localStorage
        const localStorageDump = await page.evaluate(() => {
            const out = {};
            for (let i = 0; i < localStorage.length; ++i) {
                const k = localStorage.key(i);
                out[k] = localStorage.getItem(k);
            }
            return out;
        });
        fs.writeFileSync('localstorage.txt', Object.entries(localStorageDump).map(([k, v]) => `${k}\t${v}`).join('\n'), 'utf8');
        // Dump sessionStorage
        const sessionStorageDump = await page.evaluate(() => {
            const out = {};
            for (let i = 0; i < sessionStorage.length; ++i) {
                const k = sessionStorage.key(i);
                out[k] = sessionStorage.getItem(k);
            }
            return out;
        });
        fs.writeFileSync('sessionstorage.txt', Object.entries(sessionStorageDump).map(([k, v]) => `${k}\t${v}`).join('\n'), 'utf8');
        await browser.close();
        console.log("Session exported. Now let's create your DeepSeek profile.");
    }

    // Profile selection/creation (like proxy.js)
    let profiles = loadProfiles();
    let profile = null;
    if (profiles.length === 0) {
        const name = await promptUser("Enter a name for this DeepSeek profile: ");
        profile = {
            name: name.trim() || "Unnamed Profile",
            chat_id: "",
        };
        saveProfile(profile);
        console.log(`✅ Profile '${profile.name}' saved.`);
    } else {
        console.log("Available profiles:");
        profiles.forEach((p, i) => {
            console.log(`[${i + 1}] ${p.name || "Unnamed Profile"}`);
        });
        const idx = await promptUser("Select a profile number to continue: ");
        profile = profiles[parseInt(idx, 10) - 1] || profiles[0];
        console.log(`Using profile: ${profile.name}`);
    }

    // Save chat_id if found
    let chatId = profile.chat_id || "";

    // Read cookies/local/session again (in case just exported)
    let cookies = parseCookiesFile('cookies.txt');
    let localStorageData = parseStorageFile('localstorage.txt');
    let sessionStorageData = parseStorageFile('sessionstorage.txt');

    const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    if (Array.isArray(cookies) && cookies.length > 0) {
        await page.setCookie(...cookies);
    }

    // --- Event stream logging using CDP ---
    const client = await page.target().createCDPSession();
    const eventStreamRequests = new Map();

    // Live streaming: send tokens as soon as received
    client.on('Network.responseReceived', async (params) => {
        const { response, requestId } = params;
        if (
            response.url.startsWith('https://chat.deepseek.com/api/v0/chat/completion') &&
            response.headers['content-type'] &&
            response.headers['content-type'].includes('text/event-stream')
        ) {
            eventStreamRequests.set(requestId, true);
        }
    });

    client.on('Network.webSocketFrameReceived', async (params) => {
        // ...optional: handle websocket if DeepSeek uses it...
    });

    await client.send('Network.enable');

    // Set storage
    await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded' });
    await page.evaluate((localData, sessionData) => {
        if (localData && typeof localData === 'object') {
            Object.entries(localData).forEach(([k, v]) => localStorage.setItem(k, v));
        }
        if (sessionData && typeof sessionData === 'object') {
            Object.entries(sessionData).forEach(([k, v]) => sessionStorage.setItem(k, v));
        }
    }, localStorageData, sessionStorageData);
    await page.reload({ waitUntil: 'networkidle2' });

    // If chatId is present, go to chat page, else stay on home
    if (profile.chat_id) {
        await page.goto(`https://chat.deepseek.com/a/chat/s/${profile.chat_id}`, { waitUntil: 'domcontentloaded' });
    } else {
        await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded' });
    }

    // Listen for prompt input from terminal, send to textarea, stream response
    while (true) {
        const prompt = await promptUser("Enter a prompt (or 'exit' to quit): ");
        if (prompt.trim().toLowerCase() === 'exit') break;
        // Send prompt to textarea and press Enter
        try {
            await page.waitForSelector('#chat-input', { timeout: 10000 });
            await page.focus('#chat-input');
            await page.evaluate(() => { document.querySelector('#chat-input').value = ''; });
            await page.keyboard.type(prompt);
            await page.keyboard.press('Enter');
            console.log(`Prompt "${prompt}" sent. Streaming response:`);
        } catch (e) {
            console.error('Could not find or interact with the text area:', e);
            continue;
        }

        // Listen for event stream and print tokens live
        let lastResponse = '';
        let done = false;
        client.on('Network.loadingFinished', async (params) => {
            const { requestId } = params;
            if (eventStreamRequests.has(requestId)) {
                try {
                    const { body, base64Encoded } = await client.send('Network.getResponseBody', { requestId });
                    const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
                    text.split('\n').forEach(line => {
                        if (line.trim().startsWith('data:')) {
                            try {
                                const json = JSON.parse(line.trim().slice(5).trim());
                                if (typeof json.v === 'string') {
                                    process.stdout.write(json.v);
                                    lastResponse += json.v;
                                }
                                if (json.p === 'response/content' && typeof json.v === 'string') {
                                    process.stdout.write(json.v);
                                    lastResponse += json.v;
                                }
                            } catch {}
                        }
                    });
                    done = true;
                } catch (err) {
                    console.error('Error reading event stream:', err);
                }
                eventStreamRequests.delete(requestId);
            }
        });

        // Wait for response to finish
        while (!done) {
            await new Promise(res => setTimeout(res, 300));
        }
        console.log('\n');
    }

    await browser.close();
})();

// --- Model info for /api/show ---
const availableModels = [
    {
        model: "deepseek-v3",
        name: "DeepSeek-V3",
        description: "DeepSeek V3 large language model with vision and tools capabilities."
    },
    // ...add more models if needed...
];

// --- Express API for Ollama masking ---
const app = express();
app.use(bodyParser.json());

app.post("/api/show", (req, res) => {
    const modelId = req.body?.model || "deepseek-v3";
    const foundModel = availableModels.find((m) => m.model === modelId);
    const modelName = foundModel ? foundModel.name : "DeepSeek-V3";
    res.json({
        template: "{{ .System }}{{ .Prompt }}",
        capabilities: ["vision", "tools"],
        details: {
            family: "kimi",
            name: modelName,
            description: foundModel ? foundModel.description : "Kimi AI model proxy",
        },
        model_info: {
            "general.basename": modelName,
            "general.architecture": "kimi",
            "general.name": modelName,
            "kimi.context_length": 200000,
        },
    });
});

const PORT = 11434;
const HOST = "localhost";

app.listen(PORT, HOST, () => {
    console.log(`Kimi Proxy running at http://${HOST}:${PORT}`);
    console.log(
        "Ready to requests to Kimi , Continue in the Github Copilet Chat"
    );
});
