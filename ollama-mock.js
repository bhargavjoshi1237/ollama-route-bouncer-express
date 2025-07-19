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
app.use(express.json());

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROFILE_PATH = path.join(__dirname, "profiles.txt");
let activeProfile = null;

// Helper to parse cURL command pasted by user
function parseCurlCommand(curlStr) {
  try {
    // Extract URL
    const urlMatch = curlStr.match(/curl\s+["']?([^ "'^]+)["']?/i);
    const url = urlMatch ? urlMatch[1] : "";
    // Extract headers
    const headerRegex = /-H\s+["']([^"']+)["']/gi;
    let headers = {};
    let m;
    while ((m = headerRegex.exec(curlStr)) !== null) {
      const [k, v] = m[1].split(/:\s(.+)/);
      if (k && v) headers[k.toLowerCase()] = v;
    }
    // Extract chat_id from url
    const chatIdMatch = url.match(/chat_id=([a-z0-9-]+)/i);
    const chat_id = chatIdMatch ? chatIdMatch[1] : "";
    // Validate required fields
    if (!url || !headers.authorization || !chat_id) return null;
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

// CLI interface for profile selection/creation
async function selectProfile() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let profiles = loadProfiles().filter(
    (p) => p && p.url && p.headers && p.headers.authorization && p.chat_id
  );
  while (true) {
    console.log("==== Qwen Proxy Profile Manager ====");
    if (profiles.length === 0) {
      console.log(
        "No valid profiles found. You must set up a new profile to continue."
      );
      console.log(
        "Please use 'Copy as cURL (bash)' from your browser's DevTools."
      );
      console.log("1. Go to https://chat.qwen.ai and start a new chat.");
      console.log(
        "2. Open DevTools > Network tab, send a message, find the 'completions' API request."
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
        folder_id: null, // will be set later if needed
        original_chat_id: parsed.chat_id, // store original chat id
      };
      saveProfile(profile);
      console.log(`✅ Profile '${profile.name}' saved.`);
      profiles = loadProfiles().filter(
        (p) => p && p.url && p.headers && p.headers.authorization && p.chat_id
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
      console.log("1. Go to https://chat.qwen.ai and start a new chat.");
      console.log(
        "2. Open DevTools > Network tab, send a message, find the 'completions' API request."
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
        folder_id: null,
        original_chat_id: parsed.chat_id,
      };
      saveProfile(profile);
      console.log(`✅ Profile '${profile.name}' saved.`);
      profiles = loadProfiles().filter(
        (p) => p && p.url && p.headers && p.headers.authorization && p.chat_id
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

// List all chats for a profile
async function listChats(profile) {
  console.log(`📋 Listing all chats for profile: ${profile.name}`);
  try {
    const resp = await fetch("https://chat.qwen.ai/api/v2/chats/?page=1", {
      method: "GET",
      headers: {
        ...profile.headers,
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    const data = await resp.json();
    if (data && data.success && Array.isArray(data.data)) {
      data.data.forEach((chat) => {
        console.log(
          `- [${chat.id}] "${chat.title}" (created: ${new Date(
            chat.created_at * 1000
          ).toLocaleString()})`
        );
      });
    } else {
      console.log("❌ Failed to fetch chats.");
    }
  } catch (e) {
    console.log("❌ Error fetching chats:", e.message);
  }
}

// Create or get folder "Product 1"
async function getOrCreateFolder(profile) {
  // Try to find folder first
  try {
    const resp = await fetch("https://chat.qwen.ai/api/v2/folders/", {
      method: "GET",
      headers: {
        ...profile.headers,
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    const data = await resp.json();
    if (data && data.success && Array.isArray(data.data)) {
      const found = data.data.find((f) => f.name === "Product 1");
      if (found) {
        console.log(`📁 Found folder "Product 1" with id: ${found.id}`);
        return found.id;
      }
    }
  } catch (e) {
    console.log("❌ Error reading folders:", e.message);
  }
  // Create folder if not found
  try {
    const resp = await fetch("https://chat.qwen.ai/api/v2/folders/", {
      method: "POST",
      headers: {
        ...profile.headers,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Product 1" }),
    });
    const data = await resp.json();
    if (data && data.success && data.data && data.data.id) {
      console.log(`📁 Created folder "Product 1" with id: ${data.data.id}`);
      return data.data.id;
    }
  } catch (e) {
    console.log("❌ Error creating folder:", e.message);
  }
  return null;
}

// Assign chat to folder
async function assignChatToFolder(profile, chat_id, folder_id) {
  try {
    const resp = await fetch(
      `https://chat.qwen.ai/api/v2/chats/${chat_id}/folder`,
      {
        method: "POST",
        headers: {
          ...profile.headers,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ folder_id }),
      }
    );
    const data = await resp.json();
    if (data && data.success) {
      console.log(`✅ Assigned chat ${chat_id} to folder ${folder_id}`);
      return true;
    }
  } catch (e) {
    console.log("❌ Error assigning chat to folder:", e.message);
  }
  return false;
}

// Main entry
(async () => {
  activeProfile = await selectProfile();
  if (!activeProfile) {
    console.log("❌ No valid profile selected. Exiting.");
    process.exit(1);
  }
  console.log(`Using profile: ${activeProfile.name}`);

  let QWEN_CHAT_ID = activeProfile.chat_id;
  let QWEN_API = activeProfile.url;
  const QWEN_AUTH_TOKEN = activeProfile.headers.authorization;

  // Ask user for next action: continue, create new, or list chats
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((res) =>
    rl.question(
      "Choose an option: [1] Continue in original chat, [2] Create new chat, [L] List chats: ",
      res
    )
  );
  if (answer.trim().toLowerCase() === "l") {
    await listChats(activeProfile);
    const chatId = await new Promise((res) =>
      rl.question("Enter chat id to continue in, or press Enter to skip: ", res)
    );
    if (chatId && chatId.trim()) {
      activeProfile.chat_id = chatId.trim();
      // Save the update
      let profiles = loadProfiles();
      profiles = profiles.map((p) =>
        p.name === activeProfile.name ? activeProfile : p
      );
      fs.writeFileSync(
        PROFILE_PATH,
        profiles.map((p) => JSON.stringify(p)).join("\n") + "\n"
      );
      QWEN_CHAT_ID = activeProfile.chat_id;
      QWEN_API = activeProfile.url.replace(
        /chat_id=([a-z0-9-]+)/i,
        `chat_id=${QWEN_CHAT_ID}`
      );
      console.log(`Using chat_id: ${QWEN_CHAT_ID}`);
    }
    rl.close();
  } else if (answer.trim() === "2" || answer.trim().toLowerCase() === "new") {
    // Ensure folder exists
    const folder_id = await getOrCreateFolder(activeProfile);
    if (folder_id) {
      activeProfile.folder_id = folder_id;
    }
    const newChatHeaders = {
      ...activeProfile.headers,
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      authorization: QWEN_AUTH_TOKEN,
      "content-type": "application/json",
    };
    const newChatBody = JSON.stringify({
      title: "New Chat",
      models: ["qwen3-235b-a22b"],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
    });
    try {
      const resp = await fetch("https://chat.qwen.ai/api/v2/chats/new", {
        method: "POST",
        headers: newChatHeaders,
        body: newChatBody,
        referrer: "https://chat.qwen.ai/",
      });
      const data = await resp.json();
      if (data && data.success && data.data && data.data.id) {
        QWEN_CHAT_ID = data.data.id;
        QWEN_API = activeProfile.url.replace(
          /chat_id=([a-z0-9-]+)/i,
          `chat_id=${QWEN_CHAT_ID}`
        );
        activeProfile.chat_id = QWEN_CHAT_ID;
        // Save original chat id and folder id in profile
        activeProfile.original_chat_id = QWEN_CHAT_ID;
        if (activeProfile.folder_id) {
          await assignChatToFolder(
            activeProfile,
            QWEN_CHAT_ID,
            activeProfile.folder_id
          );
        }
        // Update profile in file
        let profiles = loadProfiles();
        profiles = profiles.map((p) =>
          p.name === activeProfile.name ? activeProfile : p
        );
        fs.writeFileSync(
          PROFILE_PATH,
          profiles.map((p) => JSON.stringify(p)).join("\n") + "\n"
        );
        console.log(`✅ Created new chat. Using chat_id: ${QWEN_CHAT_ID}`);
      } else {
        console.log("❌ Failed to create new chat. Using original chat_id.");
      }
    } catch (e) {
      console.log("❌ Error creating new chat:", e.message);
      console.log("Using original chat_id.");
    }
    rl.close();
  } else {
    rl.close();
  }

  // Qwen configuration (use profile if available)
  // const QWEN_CHAT_ID = activeProfile?.chat_id || "88b8455e-487e-4066-b796-d4ec11fb32e5";
  // const QWEN_API = activeProfile?.url || `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${QWEN_CHAT_ID}`;
  // const QWEN_AUTH_TOKEN = activeProfile?.headers?.authorization ||
  //   "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjA4MTc3YWUyLWMzNGItNGIyNy1hNWRlLTYxOTEwZjk2MTQ0MyIsImxhc3RfcGFzc3dvcmRfY2hhbmdlIjoxNzUxODE0NjM0LCJleHAiOjE3NTUzNzczMjJ9.o8CpYc26IVOIA5nDqr7PMENzdX7FzvLl6IjtdIq72hE";

  // In-memory conversation state tracking
  const conversationState = new Map();

  // Mock Ollama API endpoints for Copilot integration
  app.get("/api/tags", (req, res) => {
    res.json({
      models: [
        {
          name: "qwen3-normal",
          model: "qwen3-normal",
          display_name: "Qwen3 Normal",
          tags: ["normal", "standard"],
          modified_at: new Date().toISOString(),
          size: 235000000000,
          digest: "sha256:mock-digest-normal",
          details: {
            parent_model: "",
            format: "gguf",
            family: "qwen",
            families: ["qwen"],
            parameter_size: "235B",
            quantization_level: "Q4_0",
            description: "Standard Qwen3 model for normal responses",
          },
        },
        {
          name: "qwen3-thinking",
          model: "qwen3-thinking", 
          display_name: "Qwen3 Thinking",
          tags: ["thinking", "reasoning", "cot"],
          modified_at: new Date().toISOString(),
          size: 235000000000,
          digest: "sha256:mock-digest-thinking",
          details: {
            parent_model: "",
            format: "gguf",
            family: "qwen",
            families: ["qwen"],
            parameter_size: "235B",
            quantization_level: "Q4_0",
            description: "Qwen3 model with visible thinking process and reasoning",
          },
        },
      ],
    });
  });

  app.post("/api/show", (req, res) => {
    const modelId = req.body?.model || "qwen3-normal";
    const isThinking = modelId.includes("thinking");
    const modelName = isThinking ? "Qwen3 (Thinking)" : "Qwen3 (Normal)";
    
    res.json({
      template: "{{ .System }}{{ .Prompt }}",
      capabilities: ["vision", "tools"],
      details: {
        family: "qwen",
        thinking_enabled: isThinking,
        name: modelName,
        description: isThinking 
          ? "Qwen3 model with visible thinking process and reasoning"
          : "Standard Qwen3 model for normal responses"
      },
      model_info: {
        "general.basename": modelName,
        "general.architecture": "qwen",
        "general.name": modelName,
        "qwen.context_length": 32768,
        "qwen.thinking_enabled": isThinking,
      },
    });
  });

  app.post("/v1/chat/completions", async (req, res) => {
    // Find the last user message in the array
    let userMessage = "Hello";
    if (Array.isArray(req.body?.messages)) {
      // Prefer the last message with role 'user'
      const lastUserMsg = [...req.body.messages]
        .reverse()
        .find((m) => m.role === "user");
      if (lastUserMsg && lastUserMsg.content) {
        userMessage = lastUserMsg.content;
      }
    }

    const chat_id = req.body?.chat_id || QWEN_CHAT_ID;

    // Use chat_id as the conversation identifier instead of thread_id
    // This ensures we maintain the same conversation state across requests
    const conversation_key = chat_id;

    // Get or initialize conversation state
    if (!conversationState.has(conversation_key)) {
      conversationState.set(conversation_key, {
        parent_id: null,
        nextChildFid: null, // Pre-generated fid for next message
      });
    }
    const state = conversationState.get(conversation_key);

    // Generate new IDs for this message
    const user_fid = uuidv4();
    const next_child_fid = uuidv4(); // Pre-generate next message's fid
    const timestamp = Math.floor(Date.now() / 1000);

    // Detect which model is being used
    let thinking_enabled = false;
    let requestedModel = req.body?.model || "qwen3-normal";
    let modelName = "qwen3-235b-a22b"; // Use the actual Qwen API model name

    if (requestedModel.includes("thinking")) {
      thinking_enabled = true;
      // console.log(`🧠 Using THINKING mode for model: ${requestedModel}`);
    } else {
      // console.log(`💬 Using NORMAL mode for model: ${requestedModel}`);
    }

    // Build message object matching real website pattern
    const userMsgObj = {
      fid: user_fid,
      parentId: state.parent_id,
      childrenIds: [next_child_fid],
      role: "user",
      content: userMessage,
      user_action: "chat",
      files: [],
      timestamp: timestamp,
      models: [modelName],
      chat_type: "t2t",
      feature_config: {
        thinking_enabled: thinking_enabled,
        output_schema: "phase",
      },
      extra: { meta: { subChatType: "t2t" } },
      sub_chat_type: "t2t",
      parent_id: state.parent_id,
    };

    // Store the next child fid for the next request
    state.nextChildFid = next_child_fid;
    conversationState.set(conversation_key, state);

    // Prepare headers and payload
    const headers = {
      ...activeProfile?.headers,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      authorization: QWEN_AUTH_TOKEN,
      "bx-ua":
        "231!hVE3f+mUEcD+jmjBE43s3MEjUq/YvqY2leOxacSC80vTPuB9lMZY9mRWFzrwLEV0PmcfY4rL2y9YNZhfzmEHzXCUfxVmU+KZIUV3E3+hMYLq4JviVH/vXTGiCSOgVQVUrmBs3NpTTP4rZpMq5v7DarwfyuTlhwu5bylrOrTWD6NLbnLYPEvvgIxRo2xp1GiJi9Xl8uNNdq3OAPAHYhg4gX6LyPBO0SmmLHOxGqg/ieD+Ew8e+Zd++6WF1cHXG8bpHJBh+++j+ygU3+jOvsRIniixFkk3+Mj9JOQk1PgD5eOH5Kcny3ueGMhGmsfG4lYJCWboM7WeyPWGcQGGkjcrQ8Yv/mmST3VYdDdx5ipqdGRqI1dogxQFU3kdtUh8+OpxvKI0eOgEL6vDTWnpS0113T1ZV6SQkH3tazPkDMfBDiF6ojN/gk0mluGhDWl9T7LUUb/UO8i3rUUSxxD9Y79SEdawIH+Q777K0ZgdPoz3dsM83MPFtaj/4Pi4SF2/9OjaVbMEfMY4zQlVzwT68NO7ETT4FVgWhvphfVH+4LWnv9Rn18fKH+5XnT/b5UYTBFX+4H2ycVSpCuxt5rVvC0DEY7VASl+R2w+d8vjR0HL11Hv63FQ1Pkamg3Z9Mpfzo/lIlIWXF9pwLMSVBH/nQO2IY7h1+VUKZhjCFV2qqofrqbUvkjHWh7eh5pTLB8NLXZ0WMpKS9sqOX792VtgmJv7DpM27JnMoLqeIE9ziwQx65DgRa7kSpzu+Sx4XzAgDnH9hnSWW+pbbvatLwbez1bh0gOoY6ueyln+IqijnznP06ZS4t/YMiaF9lwlNVsPChTq3qHMaDjyCjqYmXJQEJOxNuXKADGANSFW+5YI+w1JoYZi9SusDQlNQJboDVmI2J//jf+F3bsPjjG3IrhR0nRhE+lBhERTrMudMZuoUv2nKgu4oH07PZnE89kxXUcRJ1AFM46HAnm5XGaaPIvKFs9bGZW+a4TIQKKLCv9q6iad4WwomSGBwDOctk2s3TAYk7Giu7lCfK3DCIPWrxt7DkRlQxEQia0KBD+M8Np7V9UFEjg2k74/IZD8sYhXTHMvDYSS1mTngkHqqF6EAFxoPKcvrd/wo+KOhau3erfwnvU1I4CqgP9CDZeGWYi0s18JCkAqVH0n9zDaP3seMvB1GIedOutWpoK+sGeBTn4QB2MsC1gQ5F+wSbEH+JAcV07pQasBJFf6N5dRbVCEtj39/xTG/Gnc00pMV/dewtziay9sqQ4GAmsLvXVN9uOdp3KhHySk/HFvwqYFUx7QPtF4O2CuZYJy/0iXtVCwujSxtaGsTxgZC2K4Wo4W54V9567uza5bH9Xc2VWyN5rx6tjpi018W0x5PWWZbxkkXU9YgFuKtfEPnYpOEPZOgpO+ViFJRtb3c78oAHUsJnYdn96WcuEsIasmwjpe/e+mUlqUjyiLUo9Oo507hzPWoaIzks/2iGZiST1ysxi7zF7egF4IJ+p+lp5Eek2+QgU24O8zW5+ZhwvHb4Z+kWDvzR7Sq/77y/0Ki5v9rrH/n1UeKSbTsqMHiNMYl/1UYisOh2CRCvkM+HVCLMC5M",
      "bx-umidtoken":
        "T2gAnYL4DBvDJlfHzvhGHbmuuGNIFZ36LRkQP39FjN4LZuue3zPJB5JQWT_76y9SuXM=",
      "bx-v": "2.5.31",
      "cache-control": "no-cache",
      "content-type": "application/json",
      pragma: "no-cache",
      "sec-ch-ua":
        '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      source: "web",
      timezone: new Date().toString().replace(/GMT[+-]\d{4}/, "GMT+0530"),
      "x-accel-buffering": "no",
      "x-request-id": uuidv4(),
    };

    // Send only current message like Python (not full history)
    const payload = {
      stream: true,
      incremental_output: true,
      chat_id: chat_id,
      chat_mode: "normal",
      model: modelName,
      parent_id: state.parent_id,
      messages: [userMsgObj], // <-- only current message like Python
      timestamp: timestamp,
    };
    // Only log essential info
    // console.log(`🔗 Proxying chat to Qwen API as chat_id: ${chat_id}`);
    try {
      const qwenRes = await fetch(
        QWEN_API.replace(/chat_id=([a-z0-9-]+)/i, `chat_id=${chat_id}`),
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
          referrer: `https://chat.qwen.ai/c/${QWEN_CHAT_ID}`,
        }
      );

      if (!qwenRes.ok) {
        const body = await qwenRes.text();
        console.error("❌ Qwen API Error:", qwenRes.status, body);
        return res.status(500).json({ error: "Qwen failed", body });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      // Stream response with proper thinking/answer separation
      let buffer = "";
      let isInThinkingPhase = false;
      let thinkingContent = "";

      qwenRes.body.on("data", (chunk) => {
        const chunkStr = chunk.toString();
        buffer += chunkStr;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim() === "" || !line.trim().startsWith("data:")) continue;
          const jsonStr = line.trim().slice(5).trim();

          try {
            const json = JSON.parse(jsonStr);

            if (
              json &&
              json.choices &&
              Array.isArray(json.choices) &&
              json.choices[0].delta
            ) {
              const delta = json.choices[0].delta;

              // Handle thinking phase
              if (delta.phase === "think") {
                if (!isInThinkingPhase) {
                  isInThinkingPhase = true;
                  // Send thinking header
                  const thinkingHeader = {
                    id: uuidv4(),
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: req.body?.model || "qwen3-normal",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          role: "assistant",
                          content: "\n<thinking>\n",
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(thinkingHeader)}\n\n`);
                }

                // Accumulate thinking content and send it
                if (delta.content) {
                  thinkingContent += delta.content;
                  const thinkingChunk = {
                    id: uuidv4(),
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: req.body?.model || "qwen3",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: delta.content,
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(thinkingChunk)}\n\n`);
                }

                // Check if thinking phase is finished
                if (delta.status === "finished") {
                  const thinkingFooter = {
                    id: uuidv4(),
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: req.body?.model || "qwen3",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content: "\n</thinking>\n\n",
                        },
                        finish_reason: null,
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(thinkingFooter)}\n\n`);
                  isInThinkingPhase = false;
                }
              }
              // Handle answer phase
              else if (delta.phase === "answer" || !delta.phase) {
                // Convert to OpenAI format
                const openaiChunk = {
                  id: uuidv4(),
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: req.body?.model || "qwen3",
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: delta.role || "assistant",
                        content: delta.content || "",
                      },
                      finish_reason:
                        delta.status === "finished" ? "stop" : null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
              }
            } else {
              // Handle non-delta messages (like [DONE])
              if (jsonStr === "[DONE]") {
                res.write(`data: [DONE]\n\n`);
              }
            }
          } catch (e) {
            // If not JSON, just forward as-is
            res.write(line + "\n");
          }
        }
      });

      qwenRes.body.on("end", () => {
        if (buffer.trim().startsWith("data:")) {
          const jsonStr = buffer.trim().slice(5).trim();
          try {
            JSON.parse(jsonStr);
            res.write(buffer);
          } catch (e) {}
        }
        res.end();
      });

      qwenRes.body.on("error", (err) => {
        console.error("❌ Stream error:", err);
        res.end();
      });
    } catch (err) {
      console.error("❌ Server error:", err);
      res
        .status(500)
        .json({ error: "Internal proxy error", details: err.message });
    }
  });

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
        "5. Select either:\n" +
        "   - 'Qwen3' for normal responses\n" +
        "   - 'Qwen3 (Thinking)' for thinking responses\n" +
        "6. Start chatting!\n" +
        "====================\n"
    );
    console.log("✅ You are free to use Copilot Chat as described above.");
  });
})();
