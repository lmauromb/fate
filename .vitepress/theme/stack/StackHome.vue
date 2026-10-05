<script setup lang="ts">
import CreateProject from './CreateProject.vue';
import ProjectCard, { type Project } from './ProjectCard.vue';
import StackShaders from './StackShaders.vue';
import './stack.css';

const layers: ReadonlyArray<
  Readonly<{
    name: string;
    note?: string;
    projects: ReadonlyArray<Project>;
  }>
> = [
  {
    name: 'Application',
    projects: [
      {
        description: 'A modern data client for the web.',
        domain: 'fate.technology',
        href: '/guide/why-fate',
        name: 'fate',
        tone: 'blue',
        type: 'data',
      },
      {
        description: 'An internationalization framework for JavaScript & React.',
        domain: 'fbtee.dev',
        href: 'https://fbtee.dev',
        name: 'fbtee',
        tone: 'purple',
        type: 'i18n',
      },
    ],
  },
  {
    name: 'Framework',
    projects: [
      {
        description: 'Deploy your stack to Cloudflare.',
        domain: 'void.cloud',
        href: 'https://void.cloud',
        name: 'Void',
        tone: 'blue',
        type: 'full-stack',
      },
      {
        description:
          'Fast, lightweight, built on Web Standards. Support for any JavaScript runtime.',
        domain: 'hono.dev',
        href: 'https://hono.dev',
        name: 'Hono',
        tone: 'pink',
        type: 'routing',
      },
    ],
  },
  {
    name: 'Toolchain',
    projects: [
      {
        description: 'The Unified Toolchain for the Web.',
        domain: 'viteplus.dev',
        href: 'https://viteplus.dev',
        name: 'Vite+',
        tone: 'purple',
        type: 'tooling',
      },
    ],
  },
  {
    name: 'Foundation',
    note: 'Bundled with Vite+',
    projects: [
      {
        description: 'The development server and build tool for the modern web.',
        domain: 'vite.dev',
        href: 'https://vite.dev',
        name: 'Vite',
        tone: 'purple',
        type: 'dev & build',
      },
      {
        description: 'Fast JavaScript bundling, powered by Rust.',
        domain: 'rolldown.rs',
        href: 'https://rolldown.rs',
        name: 'Rolldown',
        tone: 'pink',
        type: 'bundling',
      },
      {
        description: 'Next Generation Testing Framework.',
        domain: 'vitest.dev',
        href: 'https://vitest.dev',
        name: 'Vitest',
        tone: 'blue',
        type: 'testing',
      },
      {
        description: 'The Rust-powered engine for JavaScript tooling.',
        domain: 'oxc.rs',
        href: 'https://oxc.rs',
        name: 'Oxc',
        tone: 'pink',
        type: 'compiler',
      },
      {
        description: 'Fast, type-aware linting to catch problems early.',
        domain: 'oxc.rs',
        href: 'https://oxc.rs/docs/guide/usage/linter',
        name: 'Oxlint',
        tone: 'blue',
        type: 'linting',
      },
      {
        description: 'Fast, consistent formatting for your whole project.',
        domain: 'oxc.rs',
        href: 'https://oxc.rs/docs/guide/usage/formatter',
        name: 'Oxfmt',
        tone: 'purple',
        type: 'formatting',
      },
    ],
  },
  {
    name: 'Shared defaults',
    projects: [
      {
        description: 'Opinionated Oxlint config with sensible defaults.',
        domain: 'github.com/nkzw-tech',
        href: 'https://github.com/nkzw-tech/oxlint-config',
        name: '@nkzw/oxlint-config',
        tone: 'blue',
        type: 'config',
      },
    ],
  },
  {
    name: 'Utilities',
    projects: [
      {
        description:
          'Zero-dependency, type-safe Stack component for streamlining flexbox usage in React & React Native.',
        domain: 'github.com/nkzw-tech',
        href: 'https://github.com/nkzw-tech/stack',
        name: '@nkzw/stack',
        tone: 'purple',
        type: 'layout',
      },
      {
        description: 'Lightweight core JavaScript functions.',
        domain: 'github.com/nkzw-tech',
        href: 'https://github.com/nkzw-tech/core',
        name: '@nkzw/core',
        tone: 'pink',
        type: 'utilities',
      },
    ],
  },
  {
    name: 'Developer Tools',
    projects: [
      {
        description: 'A fast local diff viewer.',
        domain: 'codiff.dev',
        href: 'https://codiff.dev',
        name: 'Codiff',
        tone: 'blue',
        type: 'code review',
      },
    ],
  },
];
</script>

<template>
  <main class="fate-stack site-container">
    <section aria-labelledby="hero-title" class="hero">
      <h1 id="hero-title"><i class="fate-name">fate</i></h1>
      <p class="hero-tagline">
        <span>A modern data client for the web.</span>
        <a class="hero-get-started" href="/guide/getting-started">Get Started →</a>
      </p>
      <CreateProject />
    </section>
    <section aria-labelledby="stack-title" class="stack" id="stack">
      <h2 class="stack-title" id="stack-title">Explore the <i class="fate-name">fate</i>stack</h2>
      <p class="stack-tagline">Great tools, all the way down.</p>
      <section
        v-for="({ name, note, projects }, index) in layers"
        :key="name"
        :aria-labelledby="`layer-${index}`"
        class="stack-layer"
      >
        <div class="layer-heading">
          <h3 :id="`layer-${index}`">{{ name }}</h3>
          <span v-if="note" class="layer-note">{{ note }}</span>
        </div>
        <div :class="`project-grid shader-grid columns-${Math.min(projects.length, 3)}`">
          <ProjectCard v-for="project in projects" :key="project.name" v-bind="project" />
          <StackShaders
            :count="projects.length"
            :seed-offset="
              1 + layers.slice(0, index).reduce((count, layer) => count + layer.projects.length, 0)
            "
          />
        </div>
      </section>
    </section>
  </main>
</template>
