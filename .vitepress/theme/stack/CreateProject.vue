<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import StackShaders from './StackShaders.vue';

const commands = 'vp create fate\ncd my-app\nvp run dev:setup\nvp run dev';

const agentPrompt = `Set up a new project using the fate stack: React, TypeScript, fate, Void, fbtee, and Vite+.

Read https://fate.technology, https://void.cloud, https://fbtee.dev, and https://viteplus.dev/guide/ for current setup instructions. Use Node.js 24+ and Vite+.

Install Vite+ if it's not already installed.

Create the project in a new empty directory, using the project name I provide or my-app by default:

vp create fate -- --framework react
cd my-app
vp run dev:setup

Keep the template's full-stack Void app with the React pages router, void-fate, D1, Drizzle, and void/live for live updates. Use native Cloudflare deployment through vp exec void deploy --platform cloudflare. Preserve fbtee, Better Auth, Tailwind, React Compiler, and @nkzw/oxlint-config. Follow the generated README and AGENTS.md.

Use the template's fbtee integration for translated React components, preserving its translation extraction and runtime initialization.

Run the generated project's checks, tests, and production build, fix any setup issues, then start the app with vp run dev. Tell me the local URL, what is configured, and any remaining Cloudflare deployment setup steps.`;

type CopyKind = 'commands' | 'prompt';
const status = ref<{ kind: CopyKind; state: 'copied' | 'error' } | null>(null);
let copyRequest = 0;
let timeout: ReturnType<typeof setTimeout> | undefined;

onBeforeUnmount(() => {
  ++copyRequest;
  clearTimeout(timeout);
});

const copy = async (kind: CopyKind) => {
  const request = ++copyRequest;
  clearTimeout(timeout);
  status.value = null;
  try {
    await navigator.clipboard.writeText(kind === 'commands' ? commands : agentPrompt);
    if (request === copyRequest) {
      status.value = { kind, state: 'copied' };
      timeout = setTimeout(() => {
        status.value = null;
      }, 4000);
    }
  } catch {
    if (request === copyRequest) {
      status.value = { kind, state: 'error' };
    }
  }
};
</script>

<template>
  <section aria-label="Create a project" class="create-project" id="create">
    <div class="terminal">
      <div class="terminal-bar shader-grid">
        <span aria-hidden="true" class="terminal-dither shader-tile" />
        <StackShaders :animated="false" :count="1" />
        <strong class="terminal-label">Quick Start</strong>
        <div class="terminal-actions">
          <button @click="copy('commands')" type="button">
            {{
              status?.kind === 'commands' && status.state === 'copied'
                ? 'Copied ✓'
                : 'Copy commands'
            }}
          </button>
          <button @click="copy('prompt')" type="button">
            {{
              status?.kind === 'prompt' && status.state === 'copied' ? 'Copied ✓' : 'Copy prompt'
            }}
          </button>
        </div>
      </div>
      <pre><code><span v-for="line in commands.split('\n')" :key="line" class="command-line"><span aria-hidden="true" class="prompt">$ </span>{{ line }}</span></code></pre>
      <span aria-live="polite" :class="status?.state === 'error' ? 'copy-error' : 'sr-only'">
        {{
          status?.state === 'error'
            ? `Could not access the clipboard. Select and copy the ${status.kind === 'prompt' ? 'prompt below' : 'commands above'}.`
            : status?.state === 'copied'
              ? `${status.kind === 'prompt' ? 'Agent prompt' : 'Commands'} copied to clipboard.`
              : ''
        }}
      </span>
      <pre
        v-if="status?.kind === 'prompt' && status.state === 'error'"
        class="prompt-fallback"
      ><code>{{ agentPrompt }}</code></pre>
    </div>
    <div class="setup-details">
      <p class="setup-note">
        Requires Node.js 24+ and <a href="https://viteplus.dev/guide/">Vite+</a>.
      </p>
      <a href="https://github.com/nkzw-tech/fate/tree/main/packages/create-fate">
        Explore the templates <span aria-hidden="true">↗</span>
      </a>
    </div>
  </section>
</template>
