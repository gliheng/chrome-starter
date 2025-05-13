import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";
import fetch from "node-fetch";
import portfinder from "portfinder";
import url from "url";
import process from "process";
import os from "os";
import path from "path";
import { fileURLToPath } from "url"; // If needed for relative paths

// Optional: If you needed __dirname equivalent
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// --- Configuration ---
const SERVER_PORT = parseInt(process.env.PORT) || 8080; // Port for this proxy server
const CHROME_PATH = process.env.CHROME_PATH || getDefaultChromePath();

function getDefaultChromePath() {
  // (Same function as before - no ESM specific changes needed here)
  switch (process.platform) {
    case "darwin":
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    case "win32":
      return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"; // Check x86?
    case "linux":
      return "/usr/bin/chromium";
    default:
      console.warn(
        `Unsupported platform: ${process.platform}. Please set CHROME_PATH.`,
      );
      return "google-chrome";
  }
}
console.log(`Using Chrome path: ${CHROME_PATH}`);
// --- End Configuration ---

// --- Session Management ---
// Map: identifier -> { chromeProcess, cdpWs, debugPort, clients: Set<WebSocket> }
const activeSessions = new Map();

// --- Cleanup Function ---
function cleanupSession(identifier) {
  const session = activeSessions.get(identifier);
  if (!session) {
    console.log(`[${identifier}] No session found to clean up.`);
    return;
  }

  console.log(`[${identifier}] Cleaning up session...`);

  // 1. Close CDP WebSocket connection
  if (session.cdpWs && session.cdpWs.readyState === WebSocket.OPEN) {
    console.log(`[${identifier}] Closing CDP WebSocket.`);
    session.cdpWs.removeAllListeners("close");
    session.cdpWs.close();
  }

  // 2. Kill Chrome Process
  if (session.chromeProcess && !session.chromeProcess.killed) {
    console.log(
      `[${identifier}] Killing Chrome process (PID: ${session.chromeProcess.pid})`,
    );
    session.chromeProcess.kill("SIGTERM");
  }

  // 3. Notify remaining clients
  if (session.clients.size > 0) {
    console.log(
      `[${identifier}] Notifying ${session.clients.size} remaining clients of session closure.`,
    );
    session.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, `Chrome session '${identifier}' terminated.`);
      }
    });
    session.clients.clear();
  }

  // 4. Remove session from map
  activeSessions.delete(identifier);
  console.log(`[${identifier}] Session removed.`);
}

// --- Create HTTP Server ---
const server = http.createServer((req, res) => {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found. Use ws://localhost:[port]/ws/[identifier]");
});

// --- Create WebSocket Server ---
const wss = new WebSocketServer({ noServer: true });

// --- Main Connection Logic (async function) ---
async function handleConnection(clientWs, identifier) {
  console.log(
    `[${identifier}] Client connected. Checking for existing session...`,
  );

  let session = activeSessions.get(identifier);

  // --- Scenario 1: Join Existing Session ---
  if (session) {
    console.log(`[${identifier}] Found existing session. Adding client.`);
    if (!session.cdpWs || session.cdpWs.readyState !== WebSocket.OPEN) {
      console.error(
        `[${identifier}] Existing session found, but CDP WS is not open (${session.cdpWs?.readyState}). Cleaning up potentially stale session.`,
      );
      cleanupSession(identifier);
      clientWs.close(
        1011,
        `Underlying Chrome session '${identifier}' was not available. Please reconnect.`,
      );
      return;
    }

    session.clients.add(clientWs);
    console.log(
      `[${identifier}] Client added. Total clients: ${session.clients.size}`,
    );

    // Relay messages: This Client -> Existing CDP
    clientWs.on("message", (message) => {
      if (session.cdpWs.readyState === WebSocket.OPEN) {
        session.cdpWs.send(message);
      } else {
        console.warn(
          `[${identifier}] CDP WS closed, cannot relay message from client.`,
        );
      }
    });

    // Handle disconnect for this specific client
    clientWs.on("close", () => {
      console.log(`[${identifier}] Client disconnected.`);
      // Ensure session still exists before modifying clients (might be cleaned up by error)
      if (activeSessions.has(identifier)) {
        session.clients.delete(clientWs);
        console.log(
          `[${identifier}] Client removed. Total clients: ${session.clients.size}`,
        );
        if (session.clients.size === 0) {
          console.log(
            `[${identifier}] Last client disconnected. Cleaning up session.`,
          );
          cleanupSession(identifier);
        }
      } else {
        console.log(
          `[${identifier}] Client disconnected, but session was already cleaned up.`,
        );
      }
    });

    clientWs.on("error", (err) => {
      console.error(
        `[${identifier}] Client WebSocket error: ${err}. Removing client.`,
      );
      // Ensure session still exists
      if (activeSessions.has(identifier)) {
        session.clients.delete(clientWs);
        console.log(
          `[${identifier}] Client removed due to error. Total clients: ${session.clients.size}`,
        );
        if (session.clients.size === 0) {
          console.log(
            `[${identifier}] Last client disconnected (due to error). Cleaning up session.`,
          );
          cleanupSession(identifier);
        }
      } else {
        console.log(
          `[${identifier}] Client error, but session was already cleaned up.`,
        );
      }
    });

    return; // Finished handling connection for existing session
  }

  // --- Scenario 2: Create New Session ---
  console.log(`[${identifier}] No existing session found. Creating new one...`);
  let chromeProcess = null;
  let cdpWs = null;
  let debugPort = null;
  // Temporary variable to hold the session obj before adding to map
  let tempSessionObject = null;
  let handleChromeSpawnError, handleChromeEarlyStderr, handleChromeEarlyExit;

  let initialMessage;
  const initialMessageListener = (msg) => {
    initialMessage = msg;
  };
  clientWs.on("message", initialMessageListener);

  try {
    // 1. Find Port
    // portfinder is promise-based, no change needed
    debugPort = await portfinder.getPortPromise({ port: 9222, stopPort: 9999 });
    console.log(`[${identifier}] Using debug port: ${debugPort}`);

    // 2. Launch Chrome (spawn is the same)
    const tmpDir = path.join(
      os.tmpdir(),
      `chrome-session-${identifier}-${Date.now()}`,
    );
    const args = [
      `--remote-debugging-port=${debugPort}`,
      "--headless",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      `--user-data-dir=${tmpDir}`,
      "about:blank",
    ];
    console.log(
      `[${identifier}] Launching Chrome: ${CHROME_PATH} ${args.join(" ")}`,
    );
    chromeProcess = spawn(CHROME_PATH, args);

    // Handle Chrome process errors during launch phase using a Promise
    const chromeLaunchError = new Promise((_, reject) => {
      // Assign the actual listener functions
      handleChromeSpawnError = (err) => reject(err);
      handleChromeEarlyStderr = (data) => {
        const errorMsg = data.toString();
        console.error(`[${identifier}] Chrome stderr (early): ${errorMsg}`);
        if (
          errorMsg.includes("cannot create user data directory") ||
          errorMsg.includes("Address already in use")
        ) {
          reject(new Error(errorMsg));
        }
      };
      handleChromeEarlyExit = (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `Chrome exited immediately during launch with code ${code}, signal ${signal}`,
            ),
          );
        }
        // If exit code is 0 during startup, it's potentially okay, let timeout handle it
      };

      // Add listeners using the defined functions
      chromeProcess.on("error", handleChromeSpawnError);
      chromeProcess.stderr.once("data", handleChromeEarlyStderr);
      chromeProcess.once("exit", handleChromeEarlyExit);
    });

    // Give Chrome time to start OR fail
    try {
      await Promise.race([
        new Promise((resolve) => setTimeout(resolve, 3000)), // Wait up to 3s
        chromeLaunchError,
      ]);
    } finally {
      if (chromeProcess) {
        if (handleChromeSpawnError)
          chromeProcess.removeListener("error", handleChromeSpawnError);
        if (handleChromeEarlyStderr)
          chromeProcess.stderr.removeListener("data", handleChromeEarlyStderr);
        if (handleChromeEarlyExit)
          chromeProcess.removeListener("exit", handleChromeEarlyExit);
      }
    }

    if (!chromeProcess || chromeProcess.killed) {
      // Ensure listeners are removed if we error here
      chromeProcess?.removeAllListeners();
      throw new Error("Chrome process failed to start or exited prematurely.");
    }

    // 3. Get CDP URL (fetch is promise-based, works similarly)
    const versionUrl = `http://localhost:${debugPort}/json/version`;
    console.log(`[${identifier}] Fetching ${versionUrl}`);
    let versionInfo;
    try {
      const response = await fetch(versionUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      versionInfo = await response.json();
    } catch (fetchError) {
      throw new Error(
        `Failed to fetch/parse ${versionUrl}: ${fetchError.message}`,
      );
    }

    const webSocketDebuggerUrl = versionInfo?.webSocketDebuggerUrl;
    if (!webSocketDebuggerUrl)
      throw new Error("webSocketDebuggerUrl not found");
    console.log(`[${identifier}] Got CDP URL: ${webSocketDebuggerUrl}`);

    // 4. Connect to CDP (new WebSocket is the same)
    cdpWs = new WebSocket(webSocketDebuggerUrl);

    // Create the session object *before* setting up CDP listeners
    // This object is only added to activeSessions map *after* CDP connects
    tempSessionObject = {
      identifier: identifier,
      chromeProcess: chromeProcess,
      cdpWs: cdpWs,
      debugPort: debugPort,
      clients: new Set([clientWs]), // Add the first client
    };

    // --- Setup Event Handlers for the NEW session ---

    // 4a. Handle Chrome Process Exit (after successful start)
    chromeProcess.on("close", (code, signal) => {
      console.log(
        `[${identifier}] Chrome process exited (code ${code}, signal ${signal}). Cleaning up session.`,
      );
      cleanupSession(identifier);
    });
    chromeProcess.stderr.on("data", (data) => {
      console.error(`[${identifier}] Chrome stderr: ${data.toString().trim()}`);
    });

    // 4b. Handle CDP WebSocket Events - wait for 'open'
    await new Promise((resolve, reject) => {
      cdpWs.on("open", () => {
        console.log(`[${identifier}] CDP WebSocket connected.`);
        // NOW add the session to the map
        activeSessions.set(identifier, tempSessionObject);
        console.log(`[${identifier}] New session created and stored.`);

        // Relay: Messages FROM CDP -> All clients in this session
        cdpWs.on("message", (message) => {
          // Use tempSessionObject here as 'session' is not in scope
          tempSessionObject.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(message.toString());
            }
          });
        });
        resolve(); // CDP is ready, session stored
      });

      cdpWs.on("error", (err) => {
        console.error(
          `[${identifier}] CDP WebSocket error: ${err}. Cleaning up session.`,
        );
        // Session might not be in activeSessions map yet if error before open
        if (activeSessions.has(identifier)) {
          cleanupSession(identifier);
        } else {
          // Manual cleanup if session wasn't added to map
          console.log(
            `[${identifier}] Cleaning up resources manually (pre-map add).`,
          );
          tempSessionObject.clients.clear(); // Clear client set
          if (chromeProcess && !chromeProcess.killed)
            chromeProcess.kill("SIGTERM");
        }
        reject(err); // Reject the promise
      });

      cdpWs.on("close", (code, reason) => {
        console.log(
          `[${identifier}] CDP WebSocket closed (code ${code}, reason ${reason.toString()}). Cleaning up session.`,
        );
        if (activeSessions.has(identifier)) {
          cleanupSession(identifier);
        } else {
          // Manual cleanup if session wasn't added to map
          console.log(
            `[${identifier}] Cleaning up resources manually (pre-map add - CDP close).`,
          );
          tempSessionObject.clients.clear();
          if (chromeProcess && !chromeProcess.killed)
            chromeProcess.kill("SIGTERM");
        }
        // If CDP closes before opening, we should reject
        if (!activeSessions.has(identifier)) {
          reject(new Error(`CDP closed before opening (code ${code})`));
        }
      });
    }); // End of CDP connection promise

    // 5. Setup message relay for the FIRST client
    if (initialMessage) {
      cdpWs.send(initialMessage.toString());
      clientWs.removeListener("message", initialMessageListener);
    }
    clientWs.on("message", (message) => {
      if (cdpWs.readyState === WebSocket.OPEN) {
        cdpWs.send(message.toString());
      } else {
        console.warn(
          `[${identifier}] CDP WS closed, cannot relay message from client.`,
        );
      }
    });

    // 6. Handle disconnect/error for the FIRST client
    clientWs.on("close", () => {
      console.log(`[${identifier}] Initial client disconnected.`);
      // Session should exist in map now if CDP connected successfully
      const session = activeSessions.get(identifier);
      if (session) {
        session.clients.delete(clientWs);
        console.log(
          `[${identifier}] Client removed. Total clients: ${session.clients.size}`,
        );
        if (session.clients.size === 0) {
          console.log(
            `[${identifier}] Last client (initial) disconnected. Cleaning up session.`,
          );
          cleanupSession(identifier);
        }
      } else {
        console.log(
          `[${identifier}] Initial client disconnected, but session no longer exists.`,
        );
      }
    });
    clientWs.on("error", (err) => {
      console.error(
        `[${identifier}] Initial client WebSocket error: ${err}. Removing client.`,
      );
      const session = activeSessions.get(identifier);
      if (session) {
        session.clients.delete(clientWs);
        console.log(
          `[${identifier}] Client removed due to error. Total clients: ${session.clients.size}`,
        );
        if (session.clients.size === 0) {
          console.log(
            `[${identifier}] Last client (initial) disconnected (due to error). Cleaning up session.`,
          );
          cleanupSession(identifier);
        }
      } else {
        console.log(
          `[${identifier}] Initial client error, but session no longer exists.`,
        );
      }
    });

    console.log(
      `[${identifier}] New session fully established for initial client.`,
    );
  } catch (error) {
    console.error(`[${identifier}] Failed to create session: ${error}`);
    // Ensure partial resources are cleaned up if setup fails at any point
    cdpWs?.close(); // Safe to call close even if not open
    if (chromeProcess && !chromeProcess.killed) chromeProcess.kill("SIGTERM");
    if (activeSessions.has(identifier)) activeSessions.delete(identifier); // Remove if added prematurely
    tempSessionObject?.clients.clear(); // Ensure client isn't leaked

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(
        1011,
        `Failed to initialize session '${identifier}': ${error.message}`,
      );
    }
  }
}

// --- HTTP Server Upgrade Handling ---
server.on("upgrade", (request, socket, head) => {
  // url.parse is fine in ESM
  const parsedUrl = url.parse(request.url);
  const pathname = parsedUrl.pathname;

  // Match /ws/IDENTIFIER
  const match = pathname?.match(/^\/ws\/([\w-]+)$/); // Use optional chaining for pathname

  if (match && match[1]) {
    // Ensure identifier is captured
    const identifier = match[1];

    console.log(`WebSocket upgrade request for identifier: ${identifier}`);
    wss.handleUpgrade(request, socket, head, (ws) => {
      // handleConnection returns a promise, catch errors here
      handleConnection(ws, identifier).catch((err) => {
        console.error(
          `[${identifier}] Unhandled error during connection handling: ${err}`,
        );
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1011, "Internal server error during connection setup.");
        }
        // Attempt cleanup if a session was partially created but failed late
        if (activeSessions.has(identifier)) {
          cleanupSession(identifier);
        }
      });
    });
  } else {
    console.log(`Rejecting upgrade request for invalid path: ${pathname}`);
    socket.write(
      "HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nInvalid WebSocket path. Use ws://localhost:[port]/ws/[identifier]",
    );
    socket.destroy();
  }
});

// --- Start the Server ---
server.listen(SERVER_PORT, () => {
  console.log(
    `Multi-Session WebSocket Chrome Proxy listening on ws://localhost:${SERVER_PORT}/ws/[identifier]`,
  );
  console.log(`Using Chrome: ${CHROME_PATH}`);
  const now = new Date();
  console.log(`Server started at: ${now.toLocaleString("zh-CN")} (CST)`);
});

// --- Graceful Shutdown ---
process.on("SIGINT", () => {
  console.log(
    "\nSIGINT received. Shutting down server and all active Chrome sessions...",
  );
  // Create a copy of identifiers to iterate over, as cleanup modifies the map
  const identifiersToClean = Array.from(activeSessions.keys());
  identifiersToClean.forEach((identifier) => {
    console.log(`Shutting down session: ${identifier}`);
    cleanupSession(identifier);
  });

  wss.close(() => console.log("WebSocket server closed."));
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0); // Exit cleanly
  });

  // Force exit after a timeout
  setTimeout(() => {
    console.error("Cleanup timed out. Forcing exit.");
    process.exit(1);
  }, 5000); // 5 seconds timeout
});
