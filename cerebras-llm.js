import Cerebras from "@cerebras/cerebras_cloud_sdk";
import readline from "readline";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

// File to store Cerebras API profiles
const PROFILE_FILE = path.join(process.cwd(), "cerebras-profiles.txt");

// Supported models for Cerebras
const SUPPORTED_MODELS = [
  {
    name: "qwen-3-235b-a22b-instruct-2507",
    model: "qwen-3-235b-a22b-instruct-2507",
    display_name: "Qwen 3 235B A22B Instruct 2507",
    tags: ["qwen", "instruct"],
    description: "Qwen 3 235B A22B Instruct Model",
  },
  {
    name: "qwen-3-235b-a22b-thinking-2507",
    model: "qwen-3-235b-a22b-thinking-2507",
    display_name: "Qwen 3 235B A22B Thinking 2507",
    tags: ["qwen", "thinking"],
    description: "Qwen 3 235B A22B Thinking Model",
  },
  {
    name: "qwen-3-coder-480b",
    model: "qwen-3-coder-480b",
    display_name: "Qwen 3 Coder 480B",
    tags: ["qwen", "coder"],
    description: "Qwen 3 Coder 480B Model",
  },
  {
    name: "qwen-3-32b",
    model: "qwen-3-32b",
    display_name: "Qwen 3 32B",
    tags: ["qwen", "standard"],
    description: "Qwen 3 32B Model",
  },
  {
    name: "gpt-oss-120b",
    model: "gpt-oss-120b",
    display_name: "GPT-OSS 120B",
    tags: ["gpt-oss", "open-source"],
    description: "GPT-OSS 120B open-source model with high reasoning effort",
    default_options: {
      stream: true,
      max_completion_tokens: 65536,
      temperature: 1,
      top_p: 1,
      reasoning_effort: "high",
    },
  },
];

// Load profiles from file
function loadProfiles() {
  if (!fs.existsSync(PROFILE_FILE)) return [];
  const lines = fs
    .readFileSync(PROFILE_FILE, "utf-8")
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

// Save a new profile to file
function saveProfile(profile) {
  fs.appendFileSync(PROFILE_FILE, JSON.stringify(profile) + "\n");
}

// Prompt user to select or create a profile
async function selectProfile(profiles) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  while (true) {
    if (profiles.length > 0) {
      console.log("Available Cerebras API Key Profiles:");
      profiles.forEach((p, i) => {
        console.log(`[${i + 1}] ${p.name}`);
      });
      console.log("[N] Create a new profile");
      const answer = await new Promise((res) =>
        rl.question("Select a profile number or type 'N' to create new: ", res)
      );
      if (answer.trim().toLowerCase() === "n") {
        // Create new profile
        const name = await new Promise((res) =>
          rl.question("Enter profile name: ", res)
        );
        const apiKey = await new Promise((res) =>
          rl.question("Enter Cerebras API key: ", res)
        );
        const profile = {
          name: name.trim(),
          apiKey: apiKey.trim(),
          baseURL: "https://api.cerebras.ai/v1",
        };
        saveProfile(profile);
        rl.close();
        return profile;
      }
      const idx = parseInt(answer, 10);
      if (idx > 0 && idx <= profiles.length) {
        rl.close();
        return profiles[idx - 1];
      }
      console.log("Invalid selection. Try again.");
    } else {
      console.log("No profiles found. Please create a new profile.");
      const name = await new Promise((res) =>
        rl.question("Enter profile name: ", res)
      );
      const apiKey = await new Promise((res) =>
        rl.question("Enter Cerebras API key: ", res)
      );
      const profile = {
        name: name.trim(),
        apiKey: apiKey.trim(),
        baseURL: "https://api.cerebras.ai/v1",
      };
      saveProfile(profile);
      rl.close();
      return profile;
    }
  }
}

let cerebras = null;
let activeProfile = null;

async function main() {
  const profiles = loadProfiles();
  activeProfile = await selectProfile(profiles);

  cerebras = new Cerebras({
    apiKey: activeProfile.apiKey,
  });
}

// Express server for Ollama-compatible endpoints
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Ollama model registry for compatibility
const ollamaModels = SUPPORTED_MODELS.map((m) => ({
  ...m,
  name: `${m.name} (Cerebras)`,
  display_name: `${m.display_name} (Cerebras)`,
  modified_at: new Date().toISOString(),
  size: 100000000000,
  digest: `sha256:mock-digest-${m.name}`,
  details: {
    parent_model: "",
    format: "gguf",
    family: m.tags[0],
    families: [m.tags[0]],
    parameter_size: "Unknown",
    quantization_level: "Q4_0",
    description: m.description,
  },
}));

// /api/version endpoint for Ollama compatibility
app.get("/api/version", (req, res) => {
  res.json({ version: "0.6.4" });
});

// /api/tags endpoint (GET)
app.get("/api/tags", (req, res) => {
  res.json({ models: ollamaModels });
});

// /api/tags endpoint (POST) for Ollama's model list POST request
app.post("/api/tags", (req, res) => {
  res.json({ models: ollamaModels });
});

// /v1/chat/completions endpoint
app.post("/v1/chat/completions", async (req, res) => {
  if (!cerebras) {
    return res
      .status(503)
      .json({ error: "Cerebras client not initialized yet." });
  }
  const { model, messages, temperature, top_p, max_tokens, stream } = req.body;

  // Determine which model is being requested
  const selectedModel = model || SUPPORTED_MODELS[0].model;

  console.log(
    `Request received for model: ${selectedModel}, stream: ${stream}`
  );

  try {
    const startTime = Date.now();
    const completion = await cerebras.chat.completions.create({
      model: selectedModel,
      messages: messages || [],
      temperature: temperature ?? 0.7,
      top_p: top_p ?? 0.8,
      max_completion_tokens: max_tokens ?? 40000,
      stream: stream ?? true,
    });

    if (stream !== false) {
      // Streaming response
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let fullResponse = "";
      let totalTokensSent = 0;
      let totalTokensReceived = 0;
      let thinkingTokens = 0;
      let responseTokens = 0;

      // Calculate tokens sent (approximate)
      const messageText = messages.map((m) => m.content).join(" ");
      totalTokensSent = Math.ceil(messageText.length / 4); // Rough token estimation

      let isResponseComplete = false;

      // Handle streaming response
      for await (const chunk of completion) {
        if (
          chunk.choices &&
          chunk.choices[0] &&
          chunk.choices[0].delta &&
          chunk.choices[0].delta.content
        ) {
          fullResponse += chunk.choices[0].delta.content;
        }

        // Process chunk to add newline after thinking sections
        if (
          chunk.choices &&
          chunk.choices[0] &&
          chunk.choices[0].delta &&
          chunk.choices[0].delta.content
        ) {
          const processedContent = chunk.choices[0].delta.content.replace(
            /(<\/think>)/g,
            "$1\n"
          );
          chunk.choices[0].delta.content = processedContent;
        }

        // Check if this is the final chunk
        if (
          chunk.choices &&
          chunk.choices[0] &&
          chunk.choices[0].finish_reason
        ) {
          isResponseComplete = true;

          // Calculate tokens received and processing time
          totalTokensReceived = Math.ceil(fullResponse.length / 4);

          // Separate thinking tokens from response tokens
          const thinkingMatch = fullResponse.match(/<think>[\s\S]*?<\/think>/g);
          if (thinkingMatch) {
            const thinkingText = thinkingMatch.join("");
            thinkingTokens = Math.ceil(thinkingText.length / 4);
            responseTokens = totalTokensReceived - thinkingTokens;
          } else {
            responseTokens = totalTokensReceived;
          }

          const endTime = Date.now();
          const processingTime = (endTime - startTime) / 1000;
          const tokensPerSecond = totalTokensReceived / processingTime;

          // Embed token metrics directly into the final chunk content
          const thinkingDisplay =
            thinkingTokens > 0 ? ` | Thinked for ${thinkingTokens} tokens` : "";
          const tokenMetrics = `\n\n---\nTokens/second: ${tokensPerSecond.toFixed(
            2
          )} | Tokens sent: ${totalTokensSent} | Response tokens: ${responseTokens}${thinkingDisplay}`;

          // Add token metrics to the final chunk
          if (chunk.choices[0].delta && chunk.choices[0].delta.content) {
            chunk.choices[0].delta.content += tokenMetrics;
          } else if (chunk.choices[0].delta) {
            chunk.choices[0].delta.content = tokenMetrics;
          }
        }

        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      // Non-streaming response
      const endTime = Date.now();
      const processingTime = (endTime - startTime) / 1000;

      // Calculate tokens
      const messageText = messages.map((m) => m.content).join(" ");
      const totalTokensSent = Math.ceil(messageText.length / 4);
      const responseText = completion.choices[0]?.message?.content || "";
      const totalTokensReceived = Math.ceil(responseText.length / 4);

      // Separate thinking tokens from response tokens
      let thinkingTokens = 0;
      let responseTokens = 0;
      const thinkingMatch = responseText.match(/<think>[\s\S]*?<\/think>/g);
      if (thinkingMatch) {
        const thinkingText = thinkingMatch.join("");
        thinkingTokens = Math.ceil(thinkingText.length / 4);
        responseTokens = totalTokensReceived - thinkingTokens;
      } else {
        responseTokens = totalTokensReceived;
      }

      const tokensPerSecond = totalTokensReceived / processingTime;

      // Process response content - add newline after thinking and embed token metrics
      let processedContent = responseText;
      processedContent = processedContent.replace(/(<\/think>)/g, "$1\n");

      // Embed token metrics directly into the response content
      const thinkingDisplay =
        thinkingTokens > 0 ? ` | Thinked for ${thinkingTokens} tokens` : "";
      const tokenMetrics = `\n\n---\nTokens/second: ${tokensPerSecond.toFixed(
        2
      )} | Tokens sent: ${totalTokensSent} | Response tokens: ${responseTokens}${thinkingDisplay}`;
      processedContent += tokenMetrics;

      // Update the completion with processed content
      if (completion.choices[0]?.message) {
        completion.choices[0].message.content = processedContent;
      }

      res.json(completion);
    }
  } catch (err) {
    console.error("Cerebras API Error:", err);
    res.status(500).json({
      error: err.message,
      details: err.response?.data || "Unknown error",
    });
  }
});

// /api/show endpoint (POST) for Ollama's model info request
app.post("/api/show", (req, res) => {
  const modelId = req.body?.model || SUPPORTED_MODELS[0].model;
  const foundModel = ollamaModels.find(
    (m) => m.model === modelId || m.name === modelId
  );
  const architecture = foundModel ? foundModel.tags[0] : "qwen";
  const displayName = foundModel ? foundModel.display_name : modelId;
  const contextLength = 200000;
  res.json({
    template: "{{ .System }}{{ .Prompt }}",
    capabilities: ["vision", "tools"],
    details: {
      family: architecture,
      name: displayName,
      description: foundModel
        ? foundModel.details.description
        : "Cerebras AI model proxy",
    },
    model_info: {
      "general.basename": displayName,
      "general.architecture": architecture,
      "general.name": displayName,
      [`${architecture}.context_length`]: contextLength,
      "limits.max_prompt_tokens": contextLength - 4096,
      "limits.max_output_tokens": 4096,
    },
  });
});

// Start the Express server only after Cerebras client is initialized
async function startServer() {
  try {
    await main();
    console.log("Cerebras client initialized successfully");
  } catch (error) {
    console.error("Failed to initialize Cerebras client:", error);
    process.exit(1);
  }

  const PORT = 11434;
  app.listen(PORT, () => {
    console.log(
      `Cerebras Ollama-compatible API listening on http://localhost:${PORT}`
    );
    console.log(
      "Available models:",
      SUPPORTED_MODELS.map((m) => m.model)
    );
  });
}

startServer();
