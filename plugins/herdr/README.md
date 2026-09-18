# Vimex for Herdr

This directory is a Herdr plugin as well as the Vimex lifecycle adapter. Herdr launches Vimex in a full tab, recognizes its reported Codex state and thread id, and can route Control-clicked HTTP(S) links through the same external-action policy used by Vimex `gx`.

## Install

Install the plugin and its Vimex workspace from GitHub:

```sh
herdr plugin install RussGallaway/vimex/plugins/herdr --ref main
herdr plugin pane open --plugin vimex --entrypoint vimex --placement tab --cwd "$PWD"
```

Pin `--ref` to a release tag or commit for a reproducible install.

## Link for local development

From the repository root:

```sh
herdr plugin link ./plugins/herdr
herdr plugin list --plugin vimex
herdr plugin pane open --plugin vimex --entrypoint vimex --placement tab --cwd "$PWD"
```

The pane entrypoint requires `bun` and launches `apps/tui/src/main.tsx` from this checkout. Its launcher resolves from `HERDR_PLUGIN_ROOT`, so `--cwd` remains the project Vimex should operate on. Herdr injects the managed pane and plugin environment, so Vimex reports lifecycle, active Codex thread, connection, model, reasoning effort, cwd, branch, context use, and pending approvals.

Unregister the development link without deleting files:

```sh
herdr plugin unlink vimex
```

## URL actions

With the plugin enabled, Control-click on an HTTP(S) URL in a Herdr terminal invokes the `open-url` action. With no configuration, it uses the operating system browser. Vimex can use the same policy for `gx` through `createHerdrExternalActions()`.

To intercept URLs, find the Herdr-owned configuration directory and create `external-actions.json`:

```sh
config_dir="$(herdr plugin config-dir vimex)"
cat >"$config_dir/external-actions.json" <<'JSON'
{
  "openUrl": {
    "command": ["my-url-dispatcher", "--url", "{url}"]
  }
}
JSON
```

The command is an argv array and never runs through a shell. `{url}` is replaced in each argument; if the placeholder is absent, Vimex appends the URL. Only `http:` and `https:` targets are accepted. Remove the file to restore the platform browser.
