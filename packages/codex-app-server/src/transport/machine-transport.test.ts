import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { machineStdioOptions, quoteShell } from "./machine-transport"

test("SSH proxy resolves installed Codex on every connection without remote cwd as local cwd", () => {
  const options = machineStdioOptions("/remote/repo", {
    id: "devbox",
    sshHost: "devbox",
  })
  expect(options.command).toBe("ssh")
  expect(options.cwd).toBeUndefined()
  expect(options.args).toContain("BatchMode=yes")
  expect(options.args).toContain("ServerAliveCountMax=3")
  expect(options.args?.at(-1)).toContain("app-server daemon start")
  expect(options.args?.at(-1)).toContain("app-server proxy")
  expect(options.args?.at(-1)).toContain("app-server-daemon/current/bin/codex")
  expect(options.args?.at(-1)).not.toContain("daemon restart")
})

test("local daemon proxy and explicit fixture stdio have independent lifetimes", () => {
  const proxy = machineStdioOptions("/repo", { id: "local" })
  expect(proxy.command).toBe("sh")
  expect(proxy.args?.[1]).toContain("app-server proxy")
  expect(
    machineStdioOptions("/repo", {
      id: "local",
      mode: "stdio",
      executable: "/fixture",
    }),
  ).toEqual({ cwd: "/repo", command: "/fixture" })
})

test("shell quoting treats quotes, substitutions, and whitespace as data", () => {
  const payload = "a' $(echo injected) `echo injected`\n b"
  const result = execFileSync(
    "sh",
    ["-c", `printf '%s' ${quoteShell(payload)}`],
    { encoding: "utf8" },
  )
  expect(result).toBe(payload)
  expect(() => quoteShell("bad\0value")).toThrow()
  for (const sshHost of ["-oProxyCommand=bad", "host\ncommand", " host"])
    expect(() => machineStdioOptions("/repo", { id: "bad", sshHost })).toThrow()
})

test("machine client uses WebSocket for daemon proxy and JSONL for explicit stdio", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { createMachineCodexClient } = await import("./machine-transport")
  const directory = await mkdtemp(join(tmpdir(), "vimex proxy fixture "))
  const executable = join(directory, "codex")
  const fixture = join(directory, "server.mjs")
  await writeFile(
    executable,
    `#!/bin/sh\nif [ "$2" = "daemon" ]; then exit 0; fi\nexec ${quoteShell(process.execPath)} ${quoteShell(fixture)} "$@"\n`,
    { mode: 0o755 },
  )
  await writeFile(
    fixture,
    `
import {WebSocketServer} from ${JSON.stringify(import.meta.resolve("ws-node"))};
import {Duplex} from 'node:stream';
import {IncomingMessage} from 'node:http';
import {Socket} from 'node:net';
import {createInterface} from 'node:readline';
const answer=(message,send)=>{const request=JSON.parse(message);if(request.method==='initialize')send(JSON.stringify({id:request.id,result:{userAgent:'fixture'}}))};
if(process.argv.includes('--listen'))createInterface({input:process.stdin}).on('line',line=>answer(line,value=>process.stdout.write(value+'\\n')));
else {
 const server=new WebSocketServer({noServer:true,perMessageDeflate:false});
 let header=Buffer.alloc(0),ready=false;
 const socket=new Duplex({read(){process.stdin.resume()},write(chunk,encoding,done){process.stdout.write(chunk,encoding,done)},final(done){process.stdout.end();done()}});
 Object.assign(socket,{setNoDelay(){},setTimeout(){}});
 process.stdin.on('data',chunk=>{
  if(ready){socket.push(chunk);return}
  header=Buffer.concat([header,chunk]);const end=header.indexOf('\\r\\n\\r\\n');if(end===-1)return;
  const lines=header.subarray(0,end).toString().split('\\r\\n');lines.shift();
  const request=new IncomingMessage(new Socket());request.method='GET';request.url='/rpc';
  request.headers=Object.fromEntries(lines.map(line=>{const i=line.indexOf(':');return [line.slice(0,i).toLowerCase(),line.slice(i+1).trim()]}));
  ready=true;server.handleUpgrade(request,socket,Buffer.alloc(0),peer=>peer.on('message',data=>answer(data.toString(),value=>peer.send(value))));
  if(header.length>end+4)socket.push(header.subarray(end+4));
 });
 process.stdin.on('end',()=>process.exit(0));
}
`,
  )
  try {
    for (const mode of ["daemon", "stdio"] as const) {
      const client = createMachineCodexClient(directory, {
        id: "local",
        mode,
        executable,
      })
      try {
        expect((await client.connect()).userAgent).toBe("fixture")
      } finally {
        await client.close()
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
