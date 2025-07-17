const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const PORT = 11434; // Default Ollama port, change if needed

app.use(cors());
app.use(bodyParser.json());

app.post("/v1/chat/completions", async (req, res) => {
  console.log("=== Incoming Request ===");
  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));

  // Check if client asked for stream
  const isStream = req.body.stream === true;

  if (isStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Stream fake data token-by-token (replace with real inference output)
    const dummyTokens = ["Hello", " there,", " human.", " This", " is", " a", " mock", " stream."];

    for (const token of dummyTokens) {
      const chunk = {
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        choices: [
          {
            delta: { content: token },
            index: 0,
            finish_reason: null
          }
        ]
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      await new Promise(r => setTimeout(r, 300)); // Delay to simulate streaming
    }

    // End of stream
    res.write(`data: [DONE]\n\n`);
    res.end();
  } else {
    // Non-streaming mock response
    const mockResponse = {
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: req.body.model || "mock-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "This is a mock non-streaming reply."
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        total_tokens: 20
      }
    };
    res.json(mockResponse);
  }
});

app.listen(PORT, () => {
  console.log(`🟢 Ollama-mock API running on http://localhost:${PORT}/v1/chat/completions`);
});
