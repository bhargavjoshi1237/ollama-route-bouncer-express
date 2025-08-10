import express from "express";
import cors from "cors";
import { streamText } from "ai";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

// Load environment variables from .env.local
dotenv.config({ path: ".env.local" });

// Stats tracking
const STATS_FILE = path.join(process.cwd(), "vercelstats.txt");

// Initialize or load stats
function loadStats() {
  if (!fs.existsSync(STATS_FILE)) {
    const initialStats = {
      totalRequests: 0,
      totalTokensSent: 0,
      totalTokensReceived: 0,
      totalCost: 0,
      modelUsage: {},
      requests: [], // Store individual requests
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(initialStats));
    return initialStats;
  }

  try {
    const data = fs.readFileSync(STATS_FILE, "utf-8");
    const stats = JSON.parse(data);
    // Ensure new fields exist for backward compatibility
    if (!stats.totalCost) stats.totalCost = 0;
    if (!stats.modelUsage) stats.modelUsage = {};
    if (!stats.requests) stats.requests = [];
    return stats;
  } catch (error) {
    console.error("Error loading stats, resetting:", error);
    const initialStats = {
      totalRequests: 0,
      totalTokensSent: 0,
      totalTokensReceived: 0,
      totalCost: 0,
      modelUsage: {},
      requests: [],
    };
    fs.writeFileSync(STATS_FILE, JSON.stringify(initialStats));
    return initialStats;
  }
}

// Calculate cost for a model
function calculateCost(modelName, inputTokens, outputTokens) {
  const model = SUPPORTED_MODELS.find(
    (m) => m.model === modelName || m.name === modelName
  );
  if (!model || !model.pricing) {
    return 0; // No pricing info available
  }

  // Convert tokens to millions and calculate cost
  const inputCost = (inputTokens / 1000000) * model.pricing.input;
  const outputCost = (outputTokens / 1000000) * model.pricing.output;

  return inputCost + outputCost;
}

// Update stats with cost tracking and individual request logging
function updateStats(tokensSent, tokensReceived, modelName = "unknown") {
  const stats = loadStats();
  const cost = calculateCost(modelName, tokensSent, tokensReceived);
  const model = SUPPORTED_MODELS.find(
    (m) => m.model === modelName || m.name === modelName
  );

  // Calculate individual costs
  const inputCost = model ? (tokensSent / 1000000) * model.pricing.input : 0;
  const outputCost = model
    ? (tokensReceived / 1000000) * model.pricing.output
    : 0;

  stats.totalRequests += 1;
  stats.totalTokensSent += tokensSent;
  stats.totalTokensReceived += tokensReceived;
  stats.totalCost += cost;

  // Track per-model usage
  if (!stats.modelUsage[modelName]) {
    stats.modelUsage[modelName] = {
      requests: 0,
      tokensSent: 0,
      tokensReceived: 0,
      cost: 0,
    };
  }

  stats.modelUsage[modelName].requests += 1;
  stats.modelUsage[modelName].tokensSent += tokensSent;
  stats.modelUsage[modelName].tokensReceived += tokensReceived;
  stats.modelUsage[modelName].cost += cost;

  // Store individual request
  const request = {
    id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    model: modelName,
    displayName: model?.display_name || modelName,
    inputTokens: tokensSent,
    outputTokens: tokensReceived,
    totalTokens: tokensSent + tokensReceived,
    inputCost: parseFloat(inputCost.toFixed(8)),
    outputCost: parseFloat(outputCost.toFixed(8)),
    totalCost: parseFloat(cost.toFixed(8)),
    pricing: model?.pricing || null,
  };

  stats.requests.unshift(request); // Add to beginning for newest first

  // Keep only last 100 requests to prevent file from growing too large
  if (stats.requests.length > 100) {
    stats.requests = stats.requests.slice(0, 100);
  }

  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  return stats;
}

// Simple token estimation function
function estimateTokens(text) {
  if (!text) return 0;
  // Rough estimation: ~4 characters per token for English text
  return Math.ceil(text.length / 4);
}

// Supported models with pricing (per million tokens)
const SUPPORTED_MODELS = [
  {
    name: "alibaba/qwen-3-30b",
    model: "alibaba/qwen-3-30b",
    display_name: "Qwen 3 30B (Vercel AI)",
    tags: ["alibaba", "qwen"],
    description: "Alibaba Qwen 3 30B model",
    pricing: {
      input: 0.1, // $0.10 per million input tokens
      output: 0.3, // $0.30 per million output tokens
    },
  },
  {
    name: "alibaba/qwen-3-32b",
    model: "alibaba/qwen-3-32b",
    display_name: "Qwen 3 32B (Vercel AI)",
    tags: ["alibaba", "qwen"],
    description: "Alibaba Qwen 3 32B model",
    pricing: {
      input: 0.1,
      output: 0.3,
    },
  },
  {
    name: "anthropic/claude-4-sonnet",
    model: "anthropic/claude-4-sonnet",
    display_name: "Claude 4 Sonnet (Vercel AI)",
    tags: ["anthropic", "claude"],
    description: "Anthropic Claude 4 Sonnet model",
    pricing: {
      input: 3.0,
      output: 15.0,
    },
  },
  {
    name: "moonshotai/kimi-k2",
    model: "moonshotai/kimi-k2",
    display_name: "Kimi K2 (Vercel AI)",
    tags: ["moonshot", "kimi"],
    description: "MoonshotAI Kimi K2 model",
    pricing: {
      input: 0.55,
      output: 2.2,
    },
  },
  {
    name: "zai/glm-4.5",
    model: "zai/glm-4.5",
    display_name: "GLM 4.5 (Vercel AI)",
    tags: ["zai", "glm"],
    description: "ZAI GLM 4.5 model",
    pricing: {
      input: 0.6,
      output: 2.2,
    },
  },
];

let activeProfile = null;

async function initializeClient() {
  // For Vercel AI Gateway, we use the API key from environment
  const apiKey = process.env.AI_GATEWAY_API_KEY;

  if (!apiKey) {
    console.error("❌ AI_GATEWAY_API_KEY not found in environment variables");
    process.exit(1);
  }

  activeProfile = {
    name: "Vercel AI Gateway",
    baseURL: "https://gateway.ai.vercel.com",
    apiKey: apiKey,
  };

  // Load initial stats
  const stats = loadStats();
  console.log(`✅ Using Vercel AI Gateway`);
  console.log(
    `📊 Stats - Requests: ${stats.totalRequests}, Tokens Sent: ${
      stats.totalTokensSent
    }, Tokens Received: ${
      stats.totalTokensReceived
    }, Total Cost: $${stats.totalCost.toFixed(6)}`
  );
}

const app = express();
const PORT = process.env.PORT || 11434; // Use different port to avoid conflicts

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Debug: log all incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Ollama model registry for compatibility
const ollamaModels = SUPPORTED_MODELS.map((m) => ({
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
  },
}));

// Ollama-compatible endpoints

// /api/tags endpoint (GET) - List available models
app.get("/api/tags", (req, res) => {
  console.log("Received /api/tags GET request");
  res.json({ models: ollamaModels });
});

// /api/tags endpoint (POST) - List available models (Ollama compatibility)
app.post("/api/tags", (req, res) => {
  console.log("Received /api/tags POST request");
  res.json({ models: ollamaModels });
});

// /api/version endpoint for Ollama compatibility
app.get("/api/version", (req, res) => {
  // Return a fixed version string compatible with Copilot's minimum requirement
  res.json({ version: "0.6.4" });
});

// /api/show endpoint (POST) - Get model info
app.post("/api/show", (req, res) => {
  // console.log("Received /api/show POST request:", );
  const modelId = req.body?.model || SUPPORTED_MODELS[0].model;
  const foundModel = ollamaModels.find(
    (m) => m.model === modelId || m.name === modelId
  );

  // Determine architecture and context length
  const architecture = foundModel ? foundModel.tags[0] : "amazon";
  const displayName = foundModel ? foundModel.display_name : modelId;
  const contextLength = 128000;

  res.json({
    template: "{{ .System }}{{ .Prompt }}",
    capabilities: ["vision", "tools"],
    details: {
      family: architecture,
      name: displayName,
      description: foundModel
        ? foundModel.details.description
        : "Amazon Nova model proxy via Vercel AI",
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

// /v1/chat/completions endpoint (OpenAI-compatible)
app.post("/v1/chat/completions", async (req, res) => {
  if (!activeProfile) {
    return res
      .status(503)
      .json({ error: "AI Gateway client not initialized yet." });
  }

  try {
    const { messages, model = "alibaba/qwen-3-30b", stream = true } = req.body;

    // Calculate input tokens
    const inputText = messages
      ? messages.map((m) => m.content).join(" ")
      : "Hello!";
    const inputTokens = estimateTokens(inputText);

    const result = await streamText({
      model: model, // Use model ID as plain string for AI Gateway
      messages: messages || [{ role: "user", content: "Hello!" }],
    });

    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Access-Control-Allow-Origin", "*");

      let outputText = "";

      // Send initial chunk with proper OpenAI format
      const initialChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      };
      res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

      // Stream the text content
      for await (const textPart of result.textStream) {
        outputText += textPart;
        const chunk = {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model,
          choices: [
            {
              index: 0,
              delta: { content: textPart },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      // Calculate output tokens and update stats
      const outputTokens = estimateTokens(outputText);
      updateStats(inputTokens, outputTokens, model);

      // Send final chunk
      const finalChunk = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const text = await result.text;
      const outputTokens = estimateTokens(text);
      updateStats(inputTokens, outputTokens, model);

      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      });
    }
  } catch (error) {
    console.error("Error in /v1/chat/completions:", error);
    res.status(500).json({
      error: {
        message: error.message,
        type: "server_error",
        code: "internal_error",
      },
    });
  }
});

// GET route for /api/chat (legacy support)
app.get("/api/chat", async (req, res) => {
  if (!activeProfile) {
    return res
      .status(503)
      .json({ error: "AI Gateway client not initialized yet." });
  }

  try {
    const prompt =
      "What is the history of the San Francisco Mission-style burrito?";
    const inputTokens = estimateTokens(prompt);
    let outputText = "";

    const defaultModel = "alibaba/qwen-3-30b";
    const result = await streamText({
      model: defaultModel, // Use model ID as plain string for AI Gateway
      prompt: prompt,
    });

    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Transfer-Encoding": "chunked",
      "Access-Control-Allow-Origin": "*",
    });

    for await (const textPart of result.textStream) {
      outputText += textPart;
      res.write(textPart);
    }

    // Update stats
    const outputTokens = estimateTokens(outputText);
    updateStats(inputTokens, outputTokens, defaultModel);

    res.end();
  } catch (error) {
    console.error("Error in GET /api/chat:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// POST route for /api/chat (legacy support)
app.post("/api/chat", async (req, res) => {
  if (!activeProfile) {
    return res
      .status(503)
      .json({ error: "AI Gateway client not initialized yet." });
  }

  try {
    const { messages, model = "alibaba/qwen-3-30b" } = req.body;

    // Calculate input tokens
    const inputText = messages
      ? messages.map((m) => m.content).join(" ")
      : "Hello!";
    const inputTokens = estimateTokens(inputText);
    let outputText = "";

    const result = await streamText({
      model: model, // Use model ID as plain string for AI Gateway
      messages: messages || [{ role: "user", content: "Hello!" }],
    });

    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Transfer-Encoding": "chunked",
      "Access-Control-Allow-Origin": "*",
    });

    for await (const textPart of result.textStream) {
      outputText += textPart;
      res.write(textPart);
    }

    // Update stats
    const outputTokens = estimateTokens(outputText);
    updateStats(inputTokens, outputTokens, model);

    res.end();
  } catch (error) {
    console.error("Error in POST /api/chat:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Stats endpoint - HTML page
app.get("/api/stats", (req, res) => {
  const stats = loadStats();
  const modelUsageArray = Object.keys(stats.modelUsage).map((modelName) => ({
    model: modelName,
    displayName:
      SUPPORTED_MODELS.find((m) => m.model === modelName)?.display_name ||
      modelName,
    requests: stats.modelUsage[modelName].requests,
    tokensSent: stats.modelUsage[modelName].tokensSent,
    tokensReceived: stats.modelUsage[modelName].tokensReceived,
    cost: parseFloat(stats.modelUsage[modelName].cost.toFixed(6)),
    pricing:
      SUPPORTED_MODELS.find((m) => m.model === modelName)?.pricing || null,
  }));

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Gateway Analytics</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
            background: #fafafa;
            color: #000;
            line-height: 1.6;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 24px;
        }
        
        .header {
            margin-bottom: 32px;
        }
        
        .header h1 {
            font-size: 32px;
            font-weight: 600;
            margin-bottom: 8px;
            color: #000;
        }
        
        .header p {
            color: #666;
            font-size: 16px;
        }
        
        .metrics-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 32px;
        }
        
        .metric-card {
            background: #fff;
            border: 1px solid #eaeaea;
            border-radius: 8px;
            padding: 20px;
            transition: border-color 0.2s ease;
        }
        
        .metric-card:hover {
            border-color: #000;
        }
        
        .metric-label {
            font-size: 14px;
            color: #666;
            margin-bottom: 8px;
            font-weight: 500;
        }
        
        .metric-value {
            font-size: 24px;
            font-weight: 600;
            color: #000;
        }
        
        .metric-value.cost {
            color: #0070f3;
        }
        
        .section {
            background: #fff;
            border: 1px solid #eaeaea;
            border-radius: 8px;
            margin-bottom: 24px;
            overflow: hidden;
        }
        
        .section-header {
            padding: 20px 24px;
            border-bottom: 1px solid #eaeaea;
            background: #fafafa;
        }
        
        .section-title {
            font-size: 18px;
            font-weight: 600;
            color: #000;
        }
        
        .section-content {
            padding: 0;
        }
        
        .model-item {
            padding: 20px 24px;
            border-bottom: 1px solid #eaeaea;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background-color 0.2s ease;
        }
        
        .model-item:hover {
            background: #fafafa;
        }
        
        .model-item:last-child {
            border-bottom: none;
        }
        
        .model-info {
            flex: 1;
        }
        
        .model-name {
            font-size: 16px;
            font-weight: 500;
            color: #000;
            margin-bottom: 4px;
        }
        
        .model-stats {
            font-size: 14px;
            color: #666;
        }
        
        .model-cost {
            font-size: 16px;
            font-weight: 600;
            color: #0070f3;
        }
        
        .requests-table {
            width: 100%;
            border-collapse: collapse;
        }
        
        .requests-table th {
            background: #fafafa;
            padding: 12px 16px;
            text-align: left;
            font-size: 14px;
            font-weight: 500;
            color: #666;
            border-bottom: 1px solid #eaeaea;
        }
        
        .requests-table td {
            padding: 12px 16px;
            font-size: 14px;
            border-bottom: 1px solid #eaeaea;
        }
        
        .requests-table tr:hover {
            background: #fafafa;
        }
        
        .timestamp {
            color: #666;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
            font-size: 12px;
        }
        
        .model-tag {
            background: #f0f0f0;
            color: #666;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 500;
        }
        
        .cost-breakdown {
            display: flex;
            gap: 8px;
            font-size: 12px;
            color: #666;
        }
        
        .cost-item {
            background: #f8f8f8;
            padding: 2px 6px;
            border-radius: 3px;
        }
        
        .no-data {
            padding: 40px;
            text-align: center;
            color: #666;
        }
        
        .refresh-indicator {
            position: fixed;
            top: 24px;
            right: 24px;
            background: #000;
            color: #fff;
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 500;
        }
        
        @media (max-width: 768px) {
            .container {
                padding: 16px;
            }
            
            .metrics-grid {
                grid-template-columns: 1fr;
            }
            
            .model-item {
                flex-direction: column;
                align-items: flex-start;
                gap: 8px;
            }
            
            .requests-table {
                font-size: 12px;
            }
            
            .requests-table th,
            .requests-table td {
                padding: 8px 12px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>AI Gateway Analytics</h1>
            <p>Real-time usage statistics and cost tracking</p>
        </div>
        
        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-label">Total Requests</div>
                <div class="metric-value">${stats.totalRequests.toLocaleString()}</div>
            </div>
            
            <div class="metric-card">
                <div class="metric-label">Input Tokens</div>
                <div class="metric-value">${stats.totalTokensSent.toLocaleString()}</div>
            </div>
            
            <div class="metric-card">
                <div class="metric-label">Output Tokens</div>
                <div class="metric-value">${stats.totalTokensReceived.toLocaleString()}</div>
            </div>
            
            <div class="metric-card">
                <div class="metric-label">Total Cost</div>
                <div class="metric-value cost">$${stats.totalCost.toFixed(
                  6
                )}</div>
            </div>
        </div>
        
        ${
          modelUsageArray.length > 0
            ? `
        <div class="section">
            <div class="section-header">
                <div class="section-title">Models</div>
            </div>
            <div class="section-content">
                ${modelUsageArray
                  .map(
                    (model) => `
                    <div class="model-item">
                        <div class="model-info">
                            <div class="model-name">${model.displayName}</div>
                            <div class="model-stats">
                                ${model.requests} requests • 
                                ${model.tokensSent.toLocaleString()} in • 
                                ${model.tokensReceived.toLocaleString()} out
                                ${
                                  model.pricing
                                    ? ` • $${model.pricing.input}/M in • $${model.pricing.output}/M out`
                                    : ""
                                }
                            </div>
                        </div>
                        <div class="model-cost">$${model.cost}</div>
                    </div>
                `
                  )
                  .join("")}
            </div>
        </div>
        `
            : ""
        }
        
        ${
          stats.requests && stats.requests.length > 0
            ? `
        <div class="section">
            <div class="section-header">
                <div class="section-title">Recent Requests</div>
            </div>
            <div class="section-content">
                <table class="requests-table">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>Model</th>
                            <th>Tokens</th>
                            <th>Cost</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${stats.requests
                          .slice(0, 20)
                          .map(
                            (req) => `
                            <tr>
                                <td>
                                    <div class="timestamp">${new Date(
                                      req.timestamp
                                    ).toLocaleString()}</div>
                                </td>
                                <td>
                                    <div class="model-tag">${
                                      req.displayName
                                    }</div>
                                </td>
                                <td>
                                    <div>${req.inputTokens.toLocaleString()} in • ${req.outputTokens.toLocaleString()} out</div>
                                    <div class="cost-breakdown">
                                        <span class="cost-item">$${req.inputCost.toFixed(
                                          6
                                        )} in</span>
                                        <span class="cost-item">$${req.outputCost.toFixed(
                                          6
                                        )} out</span>
                                    </div>
                                </td>
                                <td>
                                    <div style="color: #0070f3; font-weight: 500;">$${req.totalCost.toFixed(
                                      6
                                    )}</div>
                                </td>
                            </tr>
                        `
                          )
                          .join("")}
                    </tbody>
                </table>
            </div>
        </div>
        `
            : `
        <div class="section">
            <div class="no-data">
                <p>No requests yet</p>
                <p>Make some API calls to see detailed analytics</p>
            </div>
        </div>
        `
        }
    </div>
    
    <div class="refresh-indicator">
        Auto-refresh: 30s
    </div>
    
    <script>
        // Auto-refresh every 30 seconds
        setTimeout(() => {
            window.location.reload();
        }, 30000);
    </script>
</body>
</html>`;

  res.send(html);
});

// JSON Stats endpoint for API access
app.get("/api/stats/json", (req, res) => {
  const stats = loadStats();
  res.json({
    totalRequests: stats.totalRequests,
    totalTokensSent: stats.totalTokensSent,
    totalTokensReceived: stats.totalTokensReceived,
    totalCost: parseFloat(stats.totalCost.toFixed(6)),
    averageTokensPerRequest:
      stats.totalRequests > 0
        ? Math.round(
            (stats.totalTokensSent + stats.totalTokensReceived) /
              stats.totalRequests
          )
        : 0,
    averageCostPerRequest:
      stats.totalRequests > 0
        ? parseFloat((stats.totalCost / stats.totalRequests).toFixed(6))
        : 0,
    modelUsage: Object.keys(stats.modelUsage).map((modelName) => ({
      model: modelName,
      displayName:
        SUPPORTED_MODELS.find((m) => m.model === modelName)?.display_name ||
        modelName,
      requests: stats.modelUsage[modelName].requests,
      tokensSent: stats.modelUsage[modelName].tokensSent,
      tokensReceived: stats.modelUsage[modelName].tokensReceived,
      cost: parseFloat(stats.modelUsage[modelName].cost.toFixed(6)),
      pricing:
        SUPPORTED_MODELS.find((m) => m.model === modelName)?.pricing || null,
    })),
    requests: stats.requests || [],
  });
});

// Model pricing endpoint
app.get("/api/models/pricing", (req, res) => {
  res.json({
    models: SUPPORTED_MODELS.map((model) => ({
      name: model.name,
      model: model.model,
      display_name: model.display_name,
      pricing: {
        input: model.pricing.input,
        output: model.pricing.output,
        currency: "USD",
        unit: "per million tokens",
      },
    })),
  });
});

// Cost calculation endpoint
app.post("/api/calculate-cost", (req, res) => {
  const { model, inputTokens, outputTokens } = req.body;

  if (!model || inputTokens === undefined || outputTokens === undefined) {
    return res.status(400).json({
      error: "Missing required parameters: model, inputTokens, outputTokens",
    });
  }

  const cost = calculateCost(model, inputTokens, outputTokens);
  const modelInfo = SUPPORTED_MODELS.find(
    (m) => m.model === model || m.name === model
  );

  res.json({
    model: model,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    cost: parseFloat(cost.toFixed(6)),
    breakdown: modelInfo
      ? {
          inputCost: parseFloat(
            ((inputTokens / 1000000) * modelInfo.pricing.input).toFixed(6)
          ),
          outputCost: parseFloat(
            ((outputTokens / 1000000) * modelInfo.pricing.output).toFixed(6)
          ),
          pricing: modelInfo.pricing,
        }
      : null,
  });
});

// Health check route
app.get("/", (req, res) => {
  const stats = loadStats();
  res.json({
    message: "AI Chat API Server is running!",
    profile: activeProfile
      ? {
          name: activeProfile.name,
          baseURL: activeProfile.baseURL,
        }
      : null,
    stats: {
      totalRequests: stats.totalRequests,
      totalTokensSent: stats.totalTokensSent,
      totalTokensReceived: stats.totalTokensReceived,
      totalCost: parseFloat(stats.totalCost.toFixed(6)),
    },
    endpoints: {
      "GET /api/tags": "List available models (Ollama compatible)",
      "POST /api/tags": "List available models (Ollama compatible)",
      "POST /api/show": "Get model information (Ollama compatible)",
      "POST /v1/chat/completions": "OpenAI-compatible chat completions",
      "GET /api/chat": "Test chat with default prompt (legacy)",
      "POST /api/chat": "Chat with custom messages (legacy)",
      "GET /api/stats": "View usage statistics HTML page with cost tracking",
      "GET /api/stats/json": "Get usage statistics as JSON",
      "GET /api/models/pricing": "View model pricing information",
      "POST /api/calculate-cost": "Calculate cost for specific token usage",
    },
  });
});

// Start the server only after client is initialized
async function startServer() {
  await initializeClient();

  app.listen(PORT, () => {
    console.log(
      `🚀 Vercel AI Gateway Server running on http://localhost:${PORT}`
    );
    console.log(
      `📡 OpenAI Chat API available at http://localhost:${PORT}/v1/chat/completions`
    );
    console.log(
      `� Usage  Stats available at http://localhost:${PORT}/api/stats`
    );
  });
}

startServer();
