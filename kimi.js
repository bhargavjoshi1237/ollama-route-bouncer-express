import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import fs from "fs";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILE_PATH = path.join(__dirname, "kimi-profiles.txt");
let activeProfile = null;
let availableModels = [];
let chatSessions = new Map(); // Track chat sessions by conversation ID

// Statistics tracking
let stats = {
  totalRequests: 0,
  totalTokens: 0,
  totalResponseTime: 0,
  startTime: Date.now(),
  currentRequests: 0,
};

// Clean up old chat sessions (older than 1 hour)
function cleanupOldSessions() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  for (const [sessionId, session] of chatSessions.entries()) {
    if (session.createdAt < oneHourAgo) {
      chatSessions.delete(sessionId);
    }
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupOldSessions, 30 * 60 * 1000);

// Helper to parse cURL command pasted by user
function parseCurlCommand(curlStr) {
  try {
    // Extract URL
    const urlMatch = curlStr.match(/curl\s+['"]?([^'\s]+)['"]?/i);
    const url = urlMatch ? urlMatch[1] : "";

    // Extract headers
    const headerRegex = /-H\s+['"]([^'"]+)['"]/gi;
    let headers = {};
    let m;
    while ((m = headerRegex.exec(curlStr)) !== null) {
      const [k, v] = m[1].split(/:\s(.+)/);
      if (k && v) headers[k.toLowerCase()] = v;
    }

    // Extract chat ID from URL
    const chatIdMatch = url.match(/\/chat\/([^\/]+)\/completion/);
    const chat_id = chatIdMatch ? chatIdMatch[1] : null;

    // Validate required fields
    if (!url || !headers.authorization) return null;
    return { url, headers, chat_id };
  } catch {
    return null;
  }
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

// Save profile to file
function saveProfile(profile) {
  fs.appendFileSync(PROFILE_PATH, JSON.stringify(profile) + "\n");
}

// Helper to clear terminal (cross-platform)
function clearTerminal() {
  process.stdout.write(
    process.platform === "win32" ? "\x1Bc" : "\x1b[2J\x1b[0f"
  );
}

// Get available models from Kimi
async function getAvailableModels(profile) {
  try {
    const resp = await fetch("https://www.kimi.com/api/chat/models/available", {
      method: "GET",
      headers: {
        ...profile.headers,
      },
    });
    const data = await resp.json();
    if (data && Array.isArray(data.model_list)) {
      return data.model_list;
    }
  } catch (e) {
    console.error("Error fetching models:", e.message);
  }
  return [];
}

// List all chats for a profile
async function listChats(profile) {
  console.log(`📋 Listing all chats for profile: ${profile.name}`);
  try {
    const resp = await fetch("https://www.kimi.com/api/chat/list", {
      method: "POST",
      headers: {
        ...profile.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        kimiplus_id: "",
        offset: 0,
        q: "",
        size: 50,
        with_last_segment: true,
      }),
    });
    const data = await resp.json();
    if (data && Array.isArray(data.items)) {
      data.items.forEach((chat) => {
        console.log(
          `- [${chat.id}] "${chat.name}" (created: ${new Date(
            chat.created_at
          ).toLocaleString()})`
        );
      });
      return data.items;
    } else {
      console.log("❌ Failed to fetch chats.");
    }
  } catch (e) {
    console.log("❌ Error fetching chats:", e.message);
  }
  return [];
}

// CLI interface for profile selection/creation
async function selectProfile() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let profiles = loadProfiles().filter(
    (p) => p && p.headers && p.headers.authorization
  );
  while (true) {
    console.log("==== Kimi Proxy Profile Manager ====");
    if (profiles.length === 0) {
      console.log(
        "No valid profiles found. You must set up a new profile to continue."
      );
      console.log(
        "Please use 'Copy as cURL (bash)' from your browser's DevTools."
      );
      console.log("1. Go to https://www.kimi.com and start a new chat.");
      console.log(
        "2. Open DevTools > Network tab, send a message, find the 'completion/stream' API request."
      );
      console.log("3. Right-click it, 'Copy as cURL (bash)', and paste below.");
      const curlStr = await new Promise((res) =>
        rl.question("Paste the cURL command here:\n", res)
      );
      clearTerminal();
      const parsed = parseCurlCommand(curlStr);
      if (!parsed) {
        console.log("❌ Failed to parse cURL command. Please try again.\n");
        continue;
      }
      const name = await new Promise((res) =>
        rl.question("Enter a name for this profile: ", res)
      );
      const profile = {
        name: name.trim() || "Unnamed Profile",
        url: parsed.url,
        headers: parsed.headers,
        chat_id: parsed.chat_id,
      };
      saveProfile(profile);
      console.log(`✅ Profile '${profile.name}' saved.`);
      profiles = loadProfiles().filter(
        (p) => p && p.headers && p.headers.authorization
      );
      continue;
    }
    console.log("Available profiles:");
    profiles.forEach((p, i) => {
      console.log(`[${i + 1}] ${p.name || "Unnamed Profile"}`);
    });
    console.log("[N] Create a new profile");
    const answer = await new Promise((res) =>
      rl.question(
        "Select a profile number to continue, or type 'N' to create a new profile: ",
        res
      )
    );
    if (
      answer.trim().toLowerCase() === "n" ||
      answer.trim().toLowerCase() === "new"
    ) {
      // New profile creation flow
      console.log(
        "Please use 'Copy as cURL (bash)' from your browser's DevTools."
      );
      console.log("1. Go to https://www.kimi.com and start a new chat.");
      console.log(
        "2. Open DevTools > Network tab, send a message, find the 'completion/stream' API request."
      );
      console.log("3. Right-click it, 'Copy as cURL (bash)', and paste below.");
      const curlStr = await new Promise((res) =>
        rl.question("Paste the cURL command here:\n", res)
      );
      clearTerminal();
      const parsed = parseCurlCommand(curlStr);
      if (!parsed) {
        console.log("❌ Failed to parse cURL command. Please try again.\n");
        continue;
      }
      const name = await new Promise((res) =>
        rl.question("Enter a name for this profile: ", res)
      );
      const profile = {
        name: name.trim() || "Unnamed Profile",
        url: parsed.url,
        headers: parsed.headers,
        chat_id: parsed.chat_id,
      };
      saveProfile(profile);
      console.log(`✅ Profile '${profile.name}' saved.`);
      profiles = loadProfiles().filter(
        (p) => p && p.headers && p.headers.authorization
      );
      continue;
    }
    const idx = parseInt(answer, 10);
    if (idx > 0 && idx <= profiles.length) {
      rl.close();
      return profiles[idx - 1];
    }
    console.log("❌ Invalid selection. Please try again.\n");
  }
}

// Mock Ollama API endpoints
app.get("/api/tags", (req, res) => {
  const models =
    availableModels.length > 0
      ? availableModels.map((model) => ({
          name: model.model,
          model: model.model,
          display_name: model.name,
          tags: ["kimi", "standard"],
          modified_at: new Date().toISOString(),
          size: 100000000000,
          digest: `sha256:mock-digest-${model.model}`,
          details: {
            parent_model: "",
            format: "gguf",
            family: "kimi",
            families: ["kimi"],
            parameter_size: "Unknown",
            quantization_level: "Q4_0",
            description: model.description,
          },
        }))
      : [
          {
            name: "k2",
            model: "k2",
            display_name: "K2 (WEB)",
            tags: ["flagship", "standard"],
            modified_at: new Date().toISOString(),
            size: 100000000000,
            digest: "sha256:mock-digest-k2",
            details: {
              parent_model: "",
              format: "gguf",
              family: "kimi",
              families: ["kimi"],
              parameter_size: "Unknown",
              quantization_level: "Q4_0",
              description: "Flagship model",
            },
          },
          {
            name: "k1.5",
            model: "k1.5",
            display_name: "Kimi 1.5 (WEB)",
            tags: ["vision", "efficient"],
            modified_at: new Date().toISOString(),
            size: 100000000000,
            digest: "sha256:mock-digest-k1.5",
            details: {
              parent_model: "",
              format: "gguf",
              family: "kimi",
              families: ["kimi"],
              parameter_size: "Unknown",
              quantization_level: "Q4_0",
              description: "Efficient model with vision",
            },
          },
        ];

  res.json({
    models: models,
  });
});

app.post("/api/show", (req, res) => {
  const modelId = req.body?.model || "k2";

  // Find the model in available models
  const foundModel = availableModels.find((m) => m.model === modelId);
  const modelName = foundModel ? foundModel.name : "Kimi";

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

app.post("/v1/chat/completions", async (req, res) => {
  const requestStart = Date.now();
  stats.totalRequests++;
  stats.currentRequests++;

  // Get requested model
  const requestedModel = req.body?.model || "k2";

  // Extract messages from request
  const messages = req.body?.messages || [];

  // Check if this is a new chat (only system + user message) or continuing chat
  const isNewChat =
    messages.length <= 2 &&
    messages.some((m) => m.role === "system") &&
    messages.filter((m) => m.role === "user").length === 1;

  // Extract the latest user message
  let userMessage = "Hello";
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  if (lastUserMsg && lastUserMsg.content) {
    userMessage = lastUserMsg.content;
  }

  // Generate a conversation ID based on message history to track sessions
  const conversationHash = messages
    .map((m) => `${m.role}:${m.content?.substring(0, 50)}`)
    .join("|");
  const conversationId = Buffer.from(conversationHash)
    .toString("base64")
    .substring(0, 16);

  // For new chats, create a new Kimi chat
  let chatId = null;
  if (isNewChat) {
    try {
      const newChatResp = await fetch("https://www.kimi.com/api/chat", {
        method: "POST",
        headers: {
          ...activeProfile.headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Copilot Chat",
          is_example: false,
        }),
      });
      const newChatData = await newChatResp.json();
      if (newChatData && newChatData.id) {
        chatId = newChatData.id;
        // Store the chat session
        chatSessions.set(conversationId, {
          kimiChatId: chatId,
          createdAt: new Date(),
          messageCount: 1,
        });
      }
    } catch (e) {
      console.error("Error creating new chat:", e.message);
    }
  } else {
    // Try to find existing chat session
    const session = chatSessions.get(conversationId);
    if (session) {
      chatId = session.kimiChatId;
      session.messageCount++;
    } else {
      // Fallback: use the most recent chat or create new one
      chatId = activeProfile?.current_chat_id;
      if (!chatId) {
        try {
          const newChatResp = await fetch("https://www.kimi.com/api/chat", {
            method: "POST",
            headers: {
              ...activeProfile.headers,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              name: "Copilot Chat",
              is_example: false,
            }),
          });
          const newChatData = await newChatResp.json();
          if (newChatData && newChatData.id) {
            chatId = newChatData.id;
            activeProfile.current_chat_id = chatId;
          }
        } catch (e) {
          console.error("Error creating fallback chat:", e.message);
        }
      }
    }
  }

  // Build conversation history for Kimi
  const kimiMessages = [];
  const kimiHistory = [];

  // Process all messages to build proper conversation history
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      // System messages can be included as context but Kimi doesn't use them directly
      continue;
    } else if (msg.role === "user") {
      // For the last user message, put it in messages array
      if (i === messages.length - 1) {
        kimiMessages.push({ role: "user", content: msg.content });
      } else {
        // Previous user messages go to history
        kimiHistory.push({ role: "user", content: msg.content });
      }
    } else if (msg.role === "assistant") {
      // Assistant messages go to history
      kimiHistory.push({ role: "assistant", content: msg.content });
    }
  }

  // If no current user message in messages array, use the last user message
  if (kimiMessages.length === 0 && userMessage) {
    kimiMessages.push({ role: "user", content: userMessage });
  }

  let kimiUrl = chatId
    ? `https://www.kimi.com/api/chat/${chatId}/completion/stream`
    : "https://www.kimi.com/api/chat/completion/stream";

  // Prepare Kimi payload with conversation history
  const payload = {
    kimiplus_id: "",
    extend: { sidebar: true },
    model: requestedModel,
    use_search: false,
    messages: kimiMessages,
    refs: [],
    history: kimiHistory,
    scene_labels: [],
    use_semantic_memory: false,
    use_deep_research: false,
  };

  try {
    const kimiRes = await fetch(kimiUrl, {
      method: "POST",
      headers: {
        ...activeProfile.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!kimiRes.ok) {
      const body = await kimiRes.text();
      console.error("❌ Kimi API Error:", kimiRes.status, body);
      return res.status(500).json({ error: "Kimi API failed", body });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Stream response and convert to OpenAI format
    let buffer = "";
    let messageId = uuidv4();
    let tokenCount = 0;
    let firstTokenTime = null;

    kimiRes.body.on("data", (chunk) => {
      const chunkStr = chunk.toString();
      buffer += chunkStr;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim() === "" || !line.trim().startsWith("data:")) continue;
        const jsonStr = line.trim().slice(5).trim();

        if (jsonStr === "[DONE]") {
          res.write(`data: [DONE]\n\n`);
          continue;
        }

        try {
          const json = JSON.parse(jsonStr);

          // Handle different types of Kimi responses
          if (json.event === "cmpl") {
            // Track tokens and timing
            if (json.text) {
              if (!firstTokenTime) firstTokenTime = Date.now();
              tokenCount += json.text.length / 4; // Rough token estimation
            }

            // Regular completion event
            const openaiChunk = {
              id: messageId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: json.text || "",
                  },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
          } else if (json.event === "all_done") {
            // Update stats
            const responseTime = Date.now() - requestStart;
            const ttft = firstTokenTime ? firstTokenTime - requestStart : 0; // Time to first token
            const tps =
              tokenCount > 0 && firstTokenTime
                ? tokenCount / ((Date.now() - firstTokenTime) / 1000)
                : 0;

            stats.totalTokens += Math.round(tokenCount);
            stats.totalResponseTime += responseTime;
            stats.currentRequests--;

            // Inject stats as content before finishing
            const statsText = `\n\n\n• TPS: ${
              Math.round(tps * 100) / 100
            }\n• Total Tokens: ${Math.round(tokenCount)}`;

            const statsChunk = {
              id: messageId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: statsText,
                  },
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(statsChunk)}\n\n`);

            // Completion finished
            const finishChunk = {
              id: messageId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
            res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
          } else if (json.event === "error") {
            console.error("❌ Kimi stream error:", json);
            const errorChunk = {
              id: messageId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  delta: {
                    content: `Error: ${json.error_msg || "Unknown error"}`,
                  },
                  finish_reason: "stop",
                },
              ],
            };
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          }
        } catch (e) {
          // If not JSON, skip
          continue;
        }
      }
    });

    kimiRes.body.on("end", () => {
      stats.currentRequests--;
      res.end();
    });

    kimiRes.body.on("error", (err) => {
      console.error("❌ Stream error:", err);
      stats.currentRequests--;
      res.end();
    });
  } catch (err) {
    console.error("❌ Server error:", err);
    stats.currentRequests--;
    res
      .status(500)
      .json({ error: "Internal proxy error", details: err.message });
  }
});

// Helper to parse headers.txt (tab-separated key/value)
function parseHeadersFile(path) {
  if (!fs.existsSync(path)) return {};
  const raw = fs.readFileSync(path, 'utf8');
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

// Main entry
(async () => {
  activeProfile = await selectProfile();
  if (!activeProfile) {
    console.log("❌ No valid profile selected. Exiting.");
    process.exit(1);
  }
  console.log(`Using profile: ${activeProfile.name}`);

  // Read headers.txt and merge into activeProfile.headers
  const headersTxtPath = path.join(__dirname, "headers.txt");
  const headersFromFile = parseHeadersFile(headersTxtPath);
  if (Object.keys(headersFromFile).length > 0) {
    activeProfile.headers = { ...activeProfile.headers, ...headersFromFile };
    console.log("Loaded headers from headers.txt");
  }

  // Ask user for next action: list chats, create new chat, or continue
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((res) =>
    rl.question(
      "Choose an option: [L] List chats, [N] Create new chat, [Enter] Continue: ",
      res
    )
  );

  if (answer.trim().toLowerCase() === "l") {
    const chats = await listChats(activeProfile);
    if (chats.length > 0) {
      const chatId = await new Promise((res) =>
        rl.question(
          "Enter chat ID to continue in, or press Enter to skip: ",
          res
        )
      );
      if (chatId && chatId.trim()) {
        activeProfile.current_chat_id = chatId.trim();
        console.log(`Using chat ID: ${activeProfile.current_chat_id}`);
      }
    }
  } else if (answer.trim().toLowerCase() === "n") {
    // Create new chat
    try {
      const newChatResp = await fetch("https://www.kimi.com/api/chat", {
        method: "POST",
        headers: {
          ...activeProfile.headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Copilot Chat",
          is_example: false,
        }),
      });
      const newChatData = await newChatResp.json();
      if (newChatData && newChatData.id) {
        activeProfile.current_chat_id = newChatData.id;
        console.log(
          `✅ Created new chat with ID: ${activeProfile.current_chat_id}`
        );
      } else {
        console.log("❌ Failed to create new chat, will use default behavior");
      }
    } catch (e) {
      console.log("❌ Error creating new chat:", e.message);
    }
  }
  rl.close();

  // Get available models and store them
  try {
    availableModels = await getAvailableModels(activeProfile);
  } catch (e) {
    console.error("Failed to fetch models, using defaults");
  }

  const PORT = 11434;
  const HOST = "localhost";

  app.listen(PORT, HOST, () => {
    console.log(`Kimi Proxy running at http://${HOST}:${PORT}`);
    console.log(
      "Ready to requests to Kimi , Continue in the Github Copilet Chat"
    );
  });
})();
