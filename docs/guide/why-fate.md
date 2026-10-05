# Why fate?

**_fate_** is a modern data client for the web inspired by [Relay](https://relay.dev/) and [GraphQL](https://graphql.org/). It combines view composition, normalized caching, data masking, Async React features, and type-safe data fetching.

React data fetching is still largely centered around requests. Components fetch independently, and keeping client state consistent often requires imperative cache invalidation, defensive refetching, or detailed mutation patching logic. As coding agents write more of our code, reducing imperative cache management becomes more important, not less.

Instead of caching requests, _fate_ caches normalized objects, shifts thinking to what data is required, and composes view requirements into a single request at the application root. This enables precise optimistic updates, efficient live subscriptions, and deep integration with Async React through a minimal, composable API.

## Features

<div class="fate-highlights">
  <article>
    <h3>🎑 View Composition</h3>
    <p>Components declare their data requirements using co-located “views”. Views are composed into a single request per screen, minimizing network requests and eliminating waterfalls.</p>
    <p><a href="/guide/core-concepts">Thinking in Views →</a></p>
  </article>
  <article>
    <h3>🥽 Data Masking &amp; Strict Selection</h3>
    <p>fate prevents accidental coupling and overfetching by enforcing strict data selection for each view, and masks (hides) data that components did not request.</p>
    <p><a href="/guide/views#type-safety-and-data-masking">Data Masking →</a></p>
  </article>
  <article>
    <h3>✨ AI-Ready</h3>
    <p>fate’s minimal, predictable API and explicit data selection enable local reasoning, enabling humans and AI tools to generate stable, type-safe data-fetching code.</p>
    <p><a href="https://github.com/nkzw-tech/fate/blob/main/packages/create-fate/templates/fate/drizzle/AGENTS.md">AGENTS.md ↗</a></p>
  </article>
  <article>
    <h3>⚛️ Async React &amp; Vue</h3>
    <p>fate uses modern Async React features like Actions, Suspense, and <code>use</code> for a seamless user experience. Optimistic updates enable instant UI feedback and rollbacks are handled automatically. Vue brings the same view model to composables, resources, Suspense, and a reactive FateClient provider.</p>
    <p><a href="/guide/actions">Actions in fate →</a> · <a href="/guide/vue">Vue guide →</a></p>
  </article>
</div>

## Get Started

[Getting Started →](/guide/getting-started)

Read about the [Core Concepts](/guide/core-concepts), or jump right in and learn about [Views](/guide/views).

[Introducing fate](/posts/introducing-fate) · [fate 1.0](/posts/fate-1.0)
