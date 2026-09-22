import { spawn } from "node:child_process"

export type UrlCommand = { executable: string; args: string[] }
export function urlCommand(
  target: string,
  platform: NodeJS.Platform = process.platform,
): UrlCommand {
  const url = new URL(target)
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`Unsupported URL protocol: ${url.protocol}`)
  if (platform === "darwin") return { executable: "open", args: [url.href] }
  if (platform === "win32")
    return {
      executable: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url.href],
    }
  return { executable: "xdg-open", args: [url.href] }
}
export async function openUrl(target: string): Promise<void> {
  const command = urlCommand(target)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      shell: false,
      stdio: "ignore",
    })
    child.once("error", reject)
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`URL opener exited ${code}`)),
    )
  })
}
