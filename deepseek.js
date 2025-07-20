import fs from "fs";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import readline from "readline";
import path from "path";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

// Add stealth plugin
puppeteer.use(StealthPlugin());

const PROFILE_PATH = path.join(process.cwd(), "deepseek-profiles.txt");

// Express app setup
const app = express();
app.use(cors());
app.use(express.json());

// Global variables for browser and page
let globalBrowser = null;
let globalPage = null;
let globalClient = null;
let currentProfile = null;

// Helper to read file or return empty string
function readFileOrEmpty(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return "";
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
  raw.split("\n").forEach((line) => {
    line = line.trim();
    if (!line) return;
    const [key, ...rest] = line.split("\t");
    if (!key || rest.length === 0) return;
    let value = rest.join("\t");
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
  raw.split("\n").forEach((line) => {
    line = line.trim();
    if (!line) return;
    // Split by tab
    const parts = line.split("\t");
    // Minimum: name, value, domain, path
    if (parts.length < 4) return;
    const [
      name,
      value,
      domain,
      path,
      expires, // ISO string or "Session"
      // skip size
      httpOnly,
      secure,
      sameSite,
      // skip priorityURL, hostOnly, priority
    ] = parts;
    const cookie = {
      name: name,
      value: value,
      domain: domain,
      path: path,
    };
    // Expires
    if (expires && expires !== "Session") {
      const ts = Date.parse(expires);
      if (!isNaN(ts)) cookie.expires = Math.floor(ts / 1000);
    }
    // httpOnly
    if (httpOnly && httpOnly.trim() === "✓") cookie.httpOnly = true;
    // secure
    if (secure && secure.trim() === "✓") cookie.secure = true;
    // sameSite
    if (sameSite) {
      if (sameSite === "Lax" || sameSite === "Strict" || sameSite === "None") {
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
  raw.split("\n").forEach((line) => {
    line = line.trim();
    if (!line) return;
    const [key, ...rest] = line.split("\t");
    if (!key || rest.length === 0) return;
    headers[key] = rest.join("\t");
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
  const lines = fs
    .readFileSync(PROFILE_PATH, "utf-8")
    .split("\n")
    .filter(Boolean);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Prompt user for input
function promptUser(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

// Initialize browser session
async function initializeBrowser() {
  if (globalBrowser) return; // Already initialized

  // Ensure txt files exist for user to paste data
  [
    "cookies.txt",
    "localstorage.txt",
    "sessionstorage.txt",
    "headers.txt",
  ].forEach((filename) => {
    if (!fs.existsSync(filename)) {
      fs.writeFileSync(filename, "", "utf8");
    }
  });
  // Check if we have info in the txt files
  let cookiesRaw = readFileOrEmpty("cookies.txt").trim();
  let localStorageRaw = readFileOrEmpty("localstorage.txt").trim();
  let sessionStorageRaw = readFileOrEmpty("sessionstorage.txt").trim();

  // If any file is empty, prompt user for setup
  if (!cookiesRaw || !localStorageRaw || !sessionStorageRaw) {
    console.log("DeepSeek Setup: Some required files are empty.");
    console.log(
      "Please provide your cf_clearance cookie value (to avoid captchas):"
    );
    const cfClear = await promptUser("Paste your cf_clearance cookie value: ");
    // Write cf_clearance to cookies.txt in tab-separated format
    fs.writeFileSync(
      "cookies.txt",
      `cf_clearance\t${cfClear}\t.deepseek.com\t/\tSession\t\t✓\t✓\tNone\t\t\t\n`,
      "utf8"
    );
    console.log("Launching browser for you to login to DeepSeek...");
    const browser = await puppeteer.launch({
      headless: false,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    // Set cf_clearance cookie
    await page.setCookie({
      name: "cf_clearance",
      value: cfClear,
      domain: ".deepseek.com",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "None",
    });
    await page.goto("https://chat.deepseek.com", {
      waitUntil: "domcontentloaded",
    });
    console.log(
      "Please login in the browser window, then press Enter here to continue..."
    );
    await new Promise((resolve) => {
      process.stdin.resume();
      process.stdin.once("data", () => resolve());
    });
    // Dump cookies
    const cookiesDump = await page.cookies();
    fs.writeFileSync(
      "cookies.txt",
      cookiesDump
        .map((c) =>
          [
            c.name,
            c.value,
            c.domain,
            c.path,
            c.expires ? new Date(c.expires * 1000).toISOString() : "Session",
            "",
            c.httpOnly ? "✓" : "",
            c.secure ? "✓" : "",
            c.sameSite || "",
            "",
            "",
            "",
          ].join("\t")
        )
        .join("\n"),
      "utf8"
    );
    // Dump localStorage
    const localStorageDump = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; ++i) {
        const k = localStorage.key(i);
        out[k] = localStorage.getItem(k);
      }
      return out;
    });
    fs.writeFileSync(
      "localstorage.txt",
      Object.entries(localStorageDump)
        .map(([k, v]) => `${k}\t${v}`)
        .join("\n"),
      "utf8"
    );
    // Dump sessionStorage
    const sessionStorageDump = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < sessionStorage.length; ++i) {
        const k = sessionStorage.key(i);
        out[k] = sessionStorage.getItem(k);
      }
      return out;
    });
    fs.writeFileSync(
      "sessionstorage.txt",
      Object.entries(sessionStorageDump)
        .map(([k, v]) => `${k}\t${v}`)
        .join("\n"),
      "utf8"
    );
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

  currentProfile = profile;

  // Read cookies/local/session again (in case just exported)
  let cookies = parseCookiesFile("cookies.txt");
  let localStorageData = parseStorageFile("localstorage.txt");
  let sessionStorageData = parseStorageFile("sessionstorage.txt");

  globalBrowser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox"],
  });
  globalPage = await globalBrowser.newPage();
  if (Array.isArray(cookies) && cookies.length > 0) {
    await globalPage.setCookie(...cookies);
  }

  // --- Event stream logging using CDP ---
  globalClient = await globalPage.target().createCDPSession();
  await globalClient.send("Network.enable");

  // Set storage
  await globalPage.goto("https://chat.deepseek.com", {
    waitUntil: "domcontentloaded",
  });
  await globalPage.evaluate(
    (localData, sessionData) => {
      if (localData && typeof localData === "object") {
        Object.entries(localData).forEach(([k, v]) =>
          localStorage.setItem(k, v)
        );
      }
      if (sessionData && typeof sessionData === "object") {
        Object.entries(sessionData).forEach(([k, v]) =>
          sessionStorage.setItem(k, v)
        );
      }
    },
    localStorageData,
    sessionStorageData
  );
  await globalPage.reload({ waitUntil: "networkidle2" });

  // If chatId is present, go to chat page, else stay on home
  if (profile.chat_id) {
    await globalPage.goto(
      `https://chat.deepseek.com/a/chat/s/${profile.chat_id}`,
      { waitUntil: "domcontentloaded" }
    );
  } else {
    await globalPage.goto("https://chat.deepseek.com", {
      waitUntil: "domcontentloaded",
    });
  }

  console.log("✅ Browser initialized and ready for API requests");
}

// Send prompt to DeepSeek and return streaming response
async function sendPromptToDeepSeek(prompt) {
  if (!globalPage || !globalClient) {
    throw new Error("Browser not initialized");
  }

  return new Promise(async (resolve, reject) => {
    const eventStreamRequests = new Map();
    let responseData = "";
    let isComplete = false;

    // Set up network monitoring
    const responseHandler = async (params) => {
      const { response, requestId } = params;
      if (
        response.url.startsWith(
          "https://chat.deepseek.com/api/v0/chat/completion"
        ) &&
        response.headers["content-type"] &&
        response.headers["content-type"].includes("text/event-stream")
      ) {
        eventStreamRequests.set(requestId, true);
      }
    };

    const loadingFinishedHandler = async (params) => {
      const { requestId } = params;
      if (eventStreamRequests.has(requestId)) {
        try {
          const { body, base64Encoded } = await globalClient.send(
            "Network.getResponseBody",
            { requestId }
          );
          const text = base64Encoded
            ? Buffer.from(body, "base64").toString("utf8")
            : body;

          text.split("\n").forEach((line) => {
            if (line.trim().startsWith("data:")) {
              try {
                const json = JSON.parse(line.trim().slice(5).trim());
                if (typeof json.v === "string") {
                  responseData += json.v;
                }
                if (
                  json.p === "response/content" &&
                  typeof json.v === "string"
                ) {
                  responseData += json.v;
                }
              } catch {}
            }
          });

          isComplete = true;
          globalClient.off("Network.responseReceived", responseHandler);
          globalClient.off("Network.loadingFinished", loadingFinishedHandler);
          resolve(responseData);
        } catch (err) {
          reject(err);
        }
        eventStreamRequests.delete(requestId);
      }
    };

    globalClient.on("Network.responseReceived", responseHandler);
    globalClient.on("Network.loadingFinished", loadingFinishedHandler);

    // Send prompt to textarea and press Enter - simplified approach like original
    try {
      await globalPage.waitForSelector("#chat-input", { timeout: 10000 });
      await globalPage.focus("#chat-input");

      // Clear the textarea using input event
      await globalPage.evaluate(() => {
        const el = document.querySelector("#chat-input");
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });

      // Type the message character by character
      await globalPage.type("#chat-input", prompt); // or userMessage

      // Wait until the textarea value matches the prompt
      await globalPage.waitForFunction(
        (expected) => {
          const el = document.querySelector("#chat-input");
          return el && el.value === expected;
        },
        {},
        prompt // or userMessage
      );

      // Add a short delay to ensure site registers the input
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Now press Enter
      // await globalPage.keyboard.press("Enter");

      console.log(`✅ Prompt sent: "${prompt.substring(0, 50)}..."`);
    } catch (e) {
      globalClient.off("Network.responseReceived", responseHandler);
      globalClient.off("Network.loadingFinished", loadingFinishedHandler);
      reject(
        new Error("Could not find or interact with the text area: " + e.message)
      );
    }

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!isComplete) {
        globalClient.off("Network.responseReceived", responseHandler);
        globalClient.off("Network.loadingFinished", loadingFinishedHandler);
        reject(new Error("Response timeout"));
      }
    }, 30000);
  });
}

// Ollama API endpoints
app.get("/api/tags", (req, res) => {
  res.json({
    models: [
      {
        name: "deepseek-r1",
        model: "deepseek-r1",
        display_name: "DeepSeek R1",
        tags: ["reasoning", "thinking"],
        modified_at: new Date().toISOString(),
        size: 671000000000,
        digest: "sha256:mock-digest-deepseek",
        details: {
          parent_model: "",
          format: "gguf",
          family: "deepseek",
          families: ["deepseek"],
          parameter_size: "671B",
          quantization_level: "Q4_0",
          description: "DeepSeek R1 model with advanced reasoning capabilities",
        },
      },
    ],
  });
});

app.post("/api/show", (req, res) => {
  const modelId = req.body?.model || "deepseek-r1";

  res.json({
    template: "{{ .System }}{{ .Prompt }}",
    capabilities: ["reasoning", "thinking"],
    details: {
      family: "deepseek",
      thinking_enabled: true,
      name: "DeepSeek R1",
      description: "DeepSeek R1 model with advanced reasoning capabilities",
    },
    model_info: {
      "general.basename": "DeepSeek R1",
      "general.architecture": "deepseek",
      "general.name": "DeepSeek R1",
      "deepseek.context_length": 32768,
      "deepseek.thinking_enabled": true,
    },
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  try {
    // Extract user message
    let userMessage = "Hello";
    if (Array.isArray(req.body?.messages)) {
      const lastUserMsg = [...req.body.messages]
        .reverse()
        .find((m) => m.role === "user");
      if (lastUserMsg && lastUserMsg.content) {
        userMessage = lastUserMsg.content;
      }
    }

    console.log(
      `🔗 Proxying prompt to DeepSeek: "${userMessage.substring(0, 50)}..."`
    );

    // Check if streaming is requested
    const isStreaming = req.body?.stream === true;

    if (isStreaming) {
      // Set up streaming response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Send prompt and get streaming response
      const eventStreamRequests = new Map();
      let responseStarted = false;

      const responseHandler = async (params) => {
        const { response, requestId } = params;
        if (
          response.url.startsWith(
            "https://chat.deepseek.com/api/v0/chat/completion"
          ) &&
          response.headers["content-type"] &&
          response.headers["content-type"].includes("text/event-stream")
        ) {
          eventStreamRequests.set(requestId, true);
        }
      };

      // Real-time streaming handler using dataReceived events
      const dataReceivedHandler = async (params) => {
        const { requestId, dataLength, encodedDataLength } = params;
        if (eventStreamRequests.has(requestId)) {
          try {
            const { body, base64Encoded } = await globalClient.send(
              "Network.getResponseBody",
              { requestId }
            );
            const text = base64Encoded
              ? Buffer.from(body, "base64").toString("utf8")
              : body;

            // Process each line as it comes
            text.split("\n").forEach((line) => {
              if (line.trim().startsWith("data:")) {
                try {
                  const json = JSON.parse(line.trim().slice(5).trim());
                  if (typeof json.v === "string" && json.v) {
                    // Convert to OpenAI streaming format and send immediately
                    const openaiChunk = {
                      id: uuidv4(),
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: req.body?.model || "deepseek-r1",
                      choices: [
                        {
                          index: 0,
                          delta: {
                            role: responseStarted ? undefined : "assistant",
                            content: json.v,
                          },
                          finish_reason: null,
                        },
                      ],
                    };
                    responseStarted = true;
                    res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                  }
                } catch {}
              }
            });
          } catch (err) {
            // Ignore errors during streaming, continue processing
          }
        }
      };

      const loadingFinishedHandler = async (params) => {
        const { requestId } = params;
        if (eventStreamRequests.has(requestId)) {
          try {
            // Send final completion chunk
            const finalChunk = {
              id: uuidv4(),
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: req.body?.model || "deepseek-r1",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();

            globalClient.off("Network.responseReceived", responseHandler);
            globalClient.off("Network.dataReceived", dataReceivedHandler);
            globalClient.off("Network.loadingFinished", loadingFinishedHandler);
          } catch (err) {
            console.error("Stream completion error:", err);
            res.end();
          }
          eventStreamRequests.delete(requestId);
        }
      };

      globalClient.on("Network.responseReceived", responseHandler);
      globalClient.on("Network.dataReceived", dataReceivedHandler);
      globalClient.on("Network.loadingFinished", loadingFinishedHandler);

      // Send prompt to textarea - improved approach
      try {
        await globalPage.waitForSelector("#chat-input", { timeout: 10000 });
        await globalPage.focus("#chat-input");

        // Clear the textarea first
        await globalPage.evaluate(() => {
          const el = document.querySelector("#chat-input");
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        });

        // Type the message character by character to trigger all events
        await globalPage.evaluate((msg) => {
          const el = document.querySelector("#chat-input");
          if (el) {
            el.value = msg;
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }, userMessage);

        await globalPage.type("#chat-input", " ok");
        await globalPage.keyboard.press("Enter");
        // Wait until the textarea value matches the prompt, polling up to 5 seconds
        // const maxWaitMs = 5000;
        // const pollInterval = 50;
        // let waited = 0;
        // while (waited < maxWaitMs) {
        //   const value = await globalPage.evaluate(() => {
        //     const el = document.querySelector("#chat-input");
        //     return el ? el.value : "";
        //   });
        //   if (value === userMessage) break;
        //   await new Promise((resolve) => setTimeout(resolve, pollInterval));
        //   waited += pollInterval;
        // }
        // if (waited >= maxWaitMs) {
        //   throw new Error("Timeout: Textarea did not receive full prompt");
        // }

        // Press Enter to send
       

        console.log(`✅ Prompt sent: "${userMessage.substring(0, 50)}..."`);
      } catch (e) {
        globalClient.off("Network.responseReceived", responseHandler);
        globalClient.off("Network.dataReceived", dataReceivedHandler);
        globalClient.off("Network.loadingFinished", loadingFinishedHandler);
        res
          .status(500)
          .json({ error: "Could not interact with DeepSeek interface" });
      }
    } else {
      // Non-streaming response
      const response = await sendPromptToDeepSeek(userMessage);

      res.json({
        id: uuidv4(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: req.body?.model || "deepseek-r1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: response,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: userMessage.length,
          completion_tokens: response.length,
          total_tokens: userMessage.length + response.length,
        },
      });
    }
  } catch (err) {
    console.error("❌ Server error:", err);
    res.status(500).json({
      error: "Internal proxy error",
      details: err.message,
    });
  }
});

// Initialize and start server
(async () => {
  console.log("🚀 Initializing DeepSeek Proxy...");

  try {
    await initializeBrowser();

    const PORT = 11434;
    const HOST = "localhost";

    app.listen(PORT, HOST, () => {
      console.log(`🚀 Server running at http://${HOST}:${PORT}`);
      console.log(
        "\n====================\n" +
          "Copilot Chat Integration Steps:\n" +
          "1. Open Copilot Chat.\n" +
          "2. Go to the models section.\n" +
          "3. Click 'Manage Model'.\n" +
          "4. Click 'Ollama'.\n" +
          "5. Select 'DeepSeek R1'\n" +
          "6. Start chatting!\n" +
          "====================\n"
      );
      console.log("✅ You are free to use Copilot Chat with DeepSeek R1.");
    });

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\n🛑 Shutting down...");
      if (globalBrowser) {
        await globalBrowser.close();
      }
      process.exit(0);
    });
  } catch (error) {
    console.error("❌ Failed to initialize:", error);
    process.exit(1);
  }
})();
