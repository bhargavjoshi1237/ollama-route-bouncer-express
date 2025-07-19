import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

// Qwen configuration
const QWEN_CHAT_ID = "88b8455e-487e-4066-b796-d4ec11fb32e5";
const QWEN_API = `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${QWEN_CHAT_ID}`;
const QWEN_AUTH_TOKEN =
  "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjA4MTc3YWUyLWMzNGItNGIyNy1hNWRlLTYxOTEwZjk2MTQ0MyIsImxhc3RfcGFzc3dvcmRfY2hhbmdlIjoxNzUxODE0NjM0LCJleHAiOjE3NTUzNzczMjJ9.o8CpYc26IVOIA5nDqr7PMENzdX7FzvLl6IjtdIq72hE";

// In-memory conversation state tracking
const conversationState = new Map();

// Remove unused variables

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

  console.log(
    `📝 Using parent_id: ${state.parent_id} (${
      state.parent_id ? "from previous response" : "null for first message"
    })`
  );

  // Build message object matching real website pattern
  const userMsgObj = {
    fid: user_fid,
    parentId: state.parent_id,
    childrenIds: [next_child_fid], // Pre-generated fid for next message (like real website)
    role: "user",
    content: userMessage,
    user_action: "chat",
    files: [],
    timestamp: timestamp,
    models: ["qwen3-235b-a22b"],
    chat_type: "t2t",
    feature_config: { thinking_enabled: false, output_schema: "phase" },
    extra: { meta: { subChatType: "t2t" } },
    sub_chat_type: "t2t",
    parent_id: state.parent_id,
  };

  // Store the next child fid for the next request
  state.nextChildFid = next_child_fid;
  conversationState.set(conversation_key, state);

  // Prepare headers and payload
  const headers = {
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
    model: "qwen3-235b-a22b",
    parent_id: state.parent_id,
    messages: [userMsgObj], // <-- only current message like Python
    timestamp: timestamp,
  };
  console.log(
    "🔄 Sending request to Qwen API with payload:",
    JSON.stringify(payload, null, 2)
  );

  try {
    // console.log("⏩ Sending request to Qwen API...");
    const qwenRes = await fetch(QWEN_API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      referrer: `https://chat.qwen.ai/c/${QWEN_CHAT_ID}`,
    });

    // Log the response status code
    console.log("Qwen API response status:", qwenRes.status);

    if (!qwenRes.ok) {
      const body = await qwenRes.text();
      console.error("❌ Qwen API Error:", qwenRes.status, body);
      return res.status(500).json({ error: "Qwen failed", body });
    }

    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let buffer = "";

    qwenRes.body.on("data", (chunk) => {
      const chunkStr = chunk.toString();
      buffer += chunkStr;

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim() === "" || !line.trim().startsWith("data:")) continue;
        const jsonStr = line.trim().slice(5).trim(); // Remove 'data:' prefix

        try {
          const json = JSON.parse(jsonStr);

          // Console the whole response for inspection
          console.log("Qwen API stream response:", json);

          // Following Python pattern: update parent_id after EVERY response
          // Use response_id as the next parent_id for maintaining conversation context
          if (
            json &&
            json["response.created"] &&
            json["response.created"].response_id
          ) {
            const nextParentId = json["response.created"].response_id;
            console.log(
              "🔄 Updating parent_id for next request (using response_id):",
              nextParentId
            );
            // Update parent_id after every response (like Python code)
            state.parent_id = nextParentId;
            conversationState.set(conversation_key, state);
          }

          // // Track the assistant's reply
          // if (json.role === "assistant" && json.fid) {
          //   // Always generate a new fid for assistant message
          //   const assistantFid = uuidv4();
          //   lastAssistantMessage = {
          //     ...json,
          //     fid: assistantFid, // always new
          //     parent_id: fid, // parent is the last user message's fid
          //     parentId: fid,
          //     childrenIds: [],
          //   };
          // }

          res.write(line + "\n");
        } catch (e) {
          console.error("Error parsing JSON chunk:", e);
        }
      }
    });

    qwenRes.body.on("end", () => {
      // Process any remaining buffer content
      if (buffer.trim().startsWith("data:")) {
        const jsonStr = buffer.trim().slice(5).trim();
        try {
          JSON.parse(jsonStr);
          res.write(buffer);
        } catch (e) {
          console.error("Error parsing final chunk:", e);
        }
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

app.listen(PORT, HOST, () =>
  console.log(`🚀 Server running at http://${HOST}:${PORT}`)
);
