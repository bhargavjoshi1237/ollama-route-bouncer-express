import OpenAI from "openai";
import readline from "readline";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

// File to store NVIDIA API profiles
const PROFILE_FILE = path.join(process.cwd(), "nvidiaprofiles.txt");

// Supported models for Ollama listing
const SUPPORTED_MODELS = [
  {
    name: "kimi-k2",
    model: "moonshotai/kimi-k2-instruct",
    display_name: "Kimi K2 Instruct (NVIDIA LLM)",
    tags: ["kimi", "standard"],
    description: "Kimi K2 Instruct Model",
  },
  {
    name: "deepseek-r1",
    model: "deepseek-ai/deepseek-r1-0528",
    display_name: "DeepSeek R1-0528  (NVIDIA LLM)",
    tags: ["deepseek", "reasoning"],
    description: "DeepSeek R1-0528 with reasoning tokens",
  },
  {
    name: "qwen3-235b-a22b",
    model: "qwen/qwen3-235b-a22b",
    display_name: "Qwen3-235B-A22B  (NVIDIA LLM)",
    tags: ["qwen", "reasoning"],
    description: "Qwen3-235B-A22B with reasoning tokens",
  },
  {
    name: "llama-3.3-nemotron-super-49b-v1.5",
    model: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    display_name: "Llama-3.3 Nemotron Super 49B v1.5 (NVIDIA LLM)",
    tags: ["llama", "nemotron"],
    description: "NVIDIA Llama-3.3 Nemotron Super 49B v1.5 Model",
  },
  {
    name: "qwq-32b",
    model: "qwen/qwq-32b",
    display_name: "Qwen QWQ-32B (NVIDIA LLM)",
    tags: ["qwen", "qwq"],
    description: "Qwen QWQ-32B Model",
  }
];

// Load profiles from file
function loadProfiles() {
  if (!fs.existsSync(PROFILE_FILE)) return [];
  const lines = fs.readFileSync(PROFILE_FILE, "utf-8").split("\n").filter(Boolean);
  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
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
      console.log("Available NVIDIA API Key Profiles:");
      profiles.forEach((p, i) => {
        console.log(`[${i + 1}] ${p.name}`);
      });
      console.log("[N] Create a new profile");
      const answer = await new Promise(res =>
        rl.question("Select a profile number or type 'N' to create new: ", res)
      );
      if (answer.trim().toLowerCase() === "n") {
        // Create new profile
        const name = await new Promise(res => rl.question("Enter profile name: ", res));
        const apiKey = await new Promise(res => rl.question("Enter NVIDIA API key: ", res));
        const profile = {
          name: name.trim(),
          apiKey: apiKey.trim(),
          baseURL: "https://integrate.api.nvidia.com/v1"
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
      const name = await new Promise(res => rl.question("Enter profile name: ", res));
      const apiKey = await new Promise(res => rl.question("Enter NVIDIA API key: ", res));
      const profile = {
        name: name.trim(),
        apiKey: apiKey.trim(),
        baseURL: "https://integrate.api.nvidia.com/v1"
      };
      saveProfile(profile);
      rl.close();
      return profile;
    }
  }
}

let openai = null;
let activeProfile = null;

async function main() {
  const profiles = loadProfiles();
  activeProfile = await selectProfile(profiles);

  openai = new OpenAI({
    apiKey: activeProfile.apiKey,
    baseURL: activeProfile.baseURL,
  });
}

// Express server for Ollama-compatible endpoints
const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Ollama model registry for compatibility
const ollamaModels = SUPPORTED_MODELS.map(m => ({
  ...m,
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
  }
}));

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
  if (!openai) {
    return res.status(503).json({ error: "OpenAI client not initialized yet." });
  }
  const {
    model,
    messages,
    temperature,
    top_p,
    max_tokens,
    stream
  } = req.body;

  // Determine which model is being requested
  const selectedModel = model || SUPPORTED_MODELS[0].model;

  try {
    const completion = await openai.chat.completions.create({
      model: selectedModel,
      messages: messages || [],
      temperature: temperature ?? 0.6,
      top_p: top_p ?? 0.9,
      max_tokens: max_tokens ?? 4096,
      stream: stream ?? true,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Models with reasoning tokens
    const reasoningModels = [
      "deepseek-ai/deepseek-r1-0528",
      "qwen/qwen3-235b-a22b"
    ];

    if (reasoningModels.includes(selectedModel)) {
      for await (const chunk of completion) {
        const reasoning = chunk.choices[0]?.delta?.reasoning_content;
        if (reasoning) res.write(`data: ${JSON.stringify({ reasoning })}\n\n`);
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    } else {
      for await (const chunk of completion) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// /api/version endpoint for Ollama compatibility
app.get("/api/version", (req, res) => {
  // Return a fixed version string compatible with Copilot's minimum requirement
  res.json({ version: "0.6.4" });
});

// /api/show endpoint (POST) for Ollama's model info request
app.post("/api/show", (req, res) => {
  const modelId = req.body?.model || SUPPORTED_MODELS[0].model;
  const foundModel = ollamaModels.find(m => m.model === modelId || m.name === modelId);

  // Determine architecture and context length
  const architecture = foundModel ? foundModel.tags[0] : "kimi";
  const displayName = foundModel ? foundModel.display_name : modelId;
  const contextLength = 200000;

  res.json({
    template: "{{ .System }}{{ .Prompt }}",
    capabilities: ["vision", "tools"],
    details: {
      family: architecture,
      name: displayName,
      description: foundModel ? foundModel.details.description : "Kimi AI model proxy",
    },
    model_info: {
      "general.basename": displayName,
      "general.architecture": architecture,
      "general.name": displayName,
      [`${architecture}.context_length`]: contextLength,
      // Add limits for compatibility
      "limits.max_prompt_tokens": contextLength - 4096,
      "limits.max_output_tokens": 4096,
    },
  });
});

// Start the Express server only after OpenAI client is initialized
async function startServer() {
  await main();

  const PORT = 11434;
  app.listen(PORT, () => {
    console.log(`Ollama-compatible API listening on http://localhost:${PORT}`);
  });
}

startServer();
