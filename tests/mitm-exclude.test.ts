import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { isMitmHost, setMitmExcludedDomains, setupMitm, recordBlindTunnel, getBlindTunnelStats, _resetBlindTunnelStatsForTest } from "../src/mitm.js";
import { _resetDiscoveryCacheForTest } from "../src/discover.js";
import { _resetForTest } from "../src/ca.js";

// isMitmHost calls discoverMitmDomains(), which reads real client config
// files. Isolate discovery to an empty temp HOME so the assertions are
// deterministic (only DEFAULT_MITM_DOMAINS apply unless a test opts in).
const _discoverySavedEnv: Record<string, string | undefined> = {};
let _discoveryTmpHome: string | undefined;

test.before(() => {
    _discoveryTmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mitm-excl-"));
    for (const k of ["HOME", "CODEX_HOME", "ZCODE_DATA_BASE_DIR", "PI_CODING_AGENT_DIR", "PI_HOME"]) {
        _discoverySavedEnv[k] = process.env[k];
    }
    process.env.HOME = _discoveryTmpHome;
    process.env.CODEX_HOME = path.join(_discoveryTmpHome, ".codex");
    process.env.ZCODE_DATA_BASE_DIR = path.join(_discoveryTmpHome, ".zcode");
    process.env.PI_CODING_AGENT_DIR = path.join(_discoveryTmpHome, ".pi");
    _resetDiscoveryCacheForTest();
});

test.after(() => {
    for (const [k, v] of Object.entries(_discoverySavedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    _resetDiscoveryCacheForTest();
    if (_discoveryTmpHome) {
        try { fs.rmSync(_discoveryTmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

function withEnvExclude<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.BILI_MITM_EXCLUDE_DOMAINS;
    if (value === undefined) delete process.env.BILI_MITM_EXCLUDE_DOMAINS;
    else process.env.BILI_MITM_EXCLUDE_DOMAINS = value;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.BILI_MITM_EXCLUDE_DOMAINS;
        else process.env.BILI_MITM_EXCLUDE_DOMAINS = prev;
    }
}

function withConfigExclude<T>(domains: string[], fn: () => T): T {
    setMitmExcludedDomains(domains);
    try {
        return fn();
    } finally {
        setMitmExcludedDomains([]);
    }
}

test("exclusion beats the built-in default whitelist (#1040)", () => {
    assert.equal(isMitmHost("api.anthropic.com"), true);
    withEnvExclude("api.anthropic.com", () => {
        assert.equal(isMitmHost("api.anthropic.com"), false);
        assert.equal(isMitmHost("sub.api.anthropic.com"), false);
        assert.equal(isMitmHost("api.openai.com"), true);
        assert.equal(isMitmHost("chatgpt.com"), true);
    });
    assert.equal(isMitmHost("api.anthropic.com"), true);
});

test("exclusion beats extraDomains from config mitm.domains (#1040)", () => {
    withEnvExclude("zcode.z.ai", () => {
        assert.equal(isMitmHost("zcode.z.ai", ["zcode.z.ai"]), false);
        assert.equal(isMitmHost("api.zcode.z.ai", ["zcode.z.ai"]), false);
    });
    assert.equal(isMitmHost("zcode.z.ai", ["zcode.z.ai"]), true);
    assert.equal(isMitmHost("api.zcode.z.ai", ["zcode.z.ai"]), true);
});

test("exclusion beats auto-discovered domains (#1040)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mitm-excl-disc-"));
    const zcodeHome = path.join(tmp, ".zcode");
    fs.mkdirSync(path.join(zcodeHome, "v2"), { recursive: true });
    fs.writeFileSync(
        path.join(zcodeHome, "v2", "config.json"),
        JSON.stringify({ provider: { p: { options: { baseURL: "https://disc.example.com" } } } }),
    );
    const prev = process.env.ZCODE_DATA_BASE_DIR;
    process.env.ZCODE_DATA_BASE_DIR = zcodeHome;
    _resetDiscoveryCacheForTest();
    try {
        assert.equal(isMitmHost("disc.example.com"), true);
        withEnvExclude("disc.example.com", () => {
            assert.equal(isMitmHost("disc.example.com"), false);
        });
        assert.equal(isMitmHost("disc.example.com"), true);
    } finally {
        if (prev === undefined) delete process.env.ZCODE_DATA_BASE_DIR;
        else process.env.ZCODE_DATA_BASE_DIR = prev;
        _resetDiscoveryCacheForTest();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

test("exclusion matches by exact host or dot-suffix, case-insensitive (#1040)", () => {
    withEnvExclude("ZCODE.Z.AI", () => {
        assert.equal(isMitmHost("zcode.z.ai", ["zcode.z.ai"]), false);
        assert.equal(isMitmHost("API.ZCODE.Z.AI", ["zcode.z.ai"]), false);
        assert.equal(isMitmHost("cdn.zcode.z.ai", ["zcode.z.ai"]), false);
    });
});

test("exclusion does NOT swallow hyphen-spoofed or different hosts (#1040)", () => {
    withEnvExclude("zcode.z.ai", () => {
        assert.equal(isMitmHost("notzcode.z.ai", ["notzcode.z.ai"]), true);
        assert.equal(isMitmHost("cdn-zcode.z.ai", ["cdn-zcode.z.ai"]), true);
        assert.equal(isMitmHost("zcode.z.ai.evil.com", ["zcode.z.ai.evil.com"]), true);
    });
});

test("BILI_MITM_EXCLUDE_DOMAINS parses CSV with spaces and empty entries (#1040)", () => {
    withEnvExclude(" api.anthropic.com , , chatgpt.com ,", () => {
        assert.equal(isMitmHost("api.anthropic.com"), false);
        assert.equal(isMitmHost("chatgpt.com"), false);
        assert.equal(isMitmHost("api.openai.com"), true);
    });
    withEnvExclude("", () => {
        assert.equal(isMitmHost("api.anthropic.com"), true);
    });
    withEnvExclude(undefined, () => {
        assert.equal(isMitmHost("api.anthropic.com"), true);
    });
});

test("config excludeDomains merges with the env list (#1040)", () => {
    withConfigExclude(["api.openai.com"], () => {
        withEnvExclude("chatgpt.com", () => {
            assert.equal(isMitmHost("api.openai.com"), false);
            assert.equal(isMitmHost("chatgpt.com"), false);
            assert.equal(isMitmHost("api.anthropic.com"), true);
        });
    });
    withConfigExclude([" api.openai.com ", " "], () => {
        assert.equal(isMitmHost("api.openai.com"), false);
        assert.equal(isMitmHost("chatgpt.com"), true);
    });
});

test("recordBlindTunnel: excluded host logs the exclusion line, not the add-domain advice (#1040)", () => {
    _resetBlindTunnelStatsForTest();
    const logs: string[] = [];
    const log = (msg: string) => { logs.push(msg); };
    withConfigExclude(["copilot.tencent.com"], () => {
        recordBlindTunnel("copilot.tencent.com", log);
        recordBlindTunnel("copilot.tencent.com", log);
    });
    assert.equal(getBlindTunnelStats().total, 2, "excluded tunnels are still counted");
    assert.equal(logs.length, 1, "one-time line per host");
    assert.match(logs[0], /excluded from MITM by excludeDomains/);
    assert.doesNotMatch(logs[0], /BLIND TUNNEL WARNING/);
    assert.doesNotMatch(logs[0], /"mitm"\.domains/);
});

test("recordBlindTunnel: env-excluded host gets the exclusion line too (#1040)", () => {
    _resetBlindTunnelStatsForTest();
    const logs: string[] = [];
    withEnvExclude("zcode.z.ai", () => {
        recordBlindTunnel("zcode.z.ai", (msg) => { logs.push(msg); });
    });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /excluded from MITM by excludeDomains/);
    assert.doesNotMatch(logs[0], /BLIND TUNNEL WARNING/);
    _resetBlindTunnelStatsForTest();
});

test("recordBlindTunnel: never-listed host still gets the #897 warning unchanged (#1040)", () => {
    _resetBlindTunnelStatsForTest();
    const logs: string[] = [];
    recordBlindTunnel("relay.internal", (msg) => { logs.push(msg); });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /BLIND TUNNEL WARNING/);
    assert.match(logs[0], /"mitm"\.domains/);
    assert.match(logs[0], /BILI_MITM_DOMAINS/);
    _resetBlindTunnelStatsForTest();
});

// Isolate the CA directory so setupMitm's ensureRootCA() never touches the
// real ~/.local/share/billion-context/ca.
async function withTmpCa<T>(fn: () => Promise<T> | T): Promise<T> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mitm-excl-ca-"));
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmp;
    _resetForTest();
    try {
        return await fn();
    } finally {
        if (prev === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prev;
        _resetForTest();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

/** Send a raw CONNECT and resolve once the status line is received. */
function rawConnect(port: number, host: string, connectTo: string): Promise<{ statusLine: string; socket: net.Socket }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ statusLine: string; socket: net.Socket }>();
    const socket = net.connect(port, host, () => {
        socket.write(`CONNECT ${connectTo} HTTP/1.1\r\nHost: ${connectTo}\r\n\r\n`);
    });
    let buf = "";
    const onData = (chunk: Buffer): void => {
        buf += chunk.toString("utf8");
        if (buf.includes("\r\n\r\n")) {
            socket.off("data", onData);
            resolve({ statusLine: buf.slice(0, buf.indexOf("\r\n")), socket });
        }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    return promise;
}

await test("setupMitm: an excluded whitelisted host is blind-tunnelled, not decrypted (#1040)", async () => {
    await withTmpCa(async () => {
        const echo = net.createServer((sock) => {
            sock.on("data", (c) => sock.write("ECHO:" + c.toString("utf8")));
        });
        echo.listen(0, "127.0.0.1");
        await once(echo, "listening");
        const echoPort = (echo.address() as { port: number }).port;

        const fakeProxy = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
        fakeProxy.on("connect", (_req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
            const up = net.connect(echoPort, "127.0.0.1", () => {
                socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length > 0) up.write(head);
                socket.pipe(up);
                up.pipe(socket);
            });
            up.once("error", () => { socket.destroy(); });
            socket.once("error", () => { up.destroy(); });
        });
        fakeProxy.listen(0, "127.0.0.1");
        await once(fakeProxy, "listening");
        const proxyPort = (fakeProxy.address() as { port: number }).port;

        const logs: string[] = [];
        const server = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
        setupMitm(
            server,
            ["tunnel.test"],
            (msg) => { logs.push(msg); },
            () => `http://127.0.0.1:${proxyPort}`,
            false,
            ["tunnel.test"],
        );
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const { statusLine, socket } = await rawConnect(port, "127.0.0.1", `tunnel.test:${echoPort}`);
            assert.match(statusLine, /^HTTP\/1\.1 200/);
            const reply = Promise.withResolvers<string>();
            let out = "";
            let settled = false;
            socket.on("data", (c: Buffer) => {
                out += c.toString("utf8");
                if (!settled && out.includes("ECHO:")) { settled = true; reply.resolve(out); }
            });
            socket.once("close", () => { if (!settled) reply.reject(new Error("tunnel closed before reply")); });
            socket.write("ping");
            const body = await reply.promise;
            assert.match(body, /ECHO:ping/, "excluded host must be blind-tunnelled through the resolved proxy");
            assert.ok(
                logs.some((l) => /tunnel .* established \(blind TCP, not decrypted\)/.test(l)),
                "the blind-tunnel path must be taken, not TLS termination",
            );
            assert.equal(logs.filter((l) => l.includes("BLIND TUNNEL WARNING")).length, 0, "deliberate exclusion must not produce the add-domain advice");
            assert.equal(logs.filter((l) => l.includes("excluded from MITM by excludeDomains")).length, 1);
            socket.destroy();
        } finally {
            server.close();
            server.closeAllConnections?.();
            echo.close();
            echo.closeAllConnections?.();
            fakeProxy.close();
            fakeProxy.closeAllConnections?.();
        }
    });
});
