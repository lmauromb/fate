<script setup lang="ts">
export type Project = Readonly<{
  description: string;
  domain: string;
  href: string;
  name: string;
  tone: 'blue' | 'pink' | 'purple';
  type: string;
}>;

defineProps<Project>();
</script>

<template>
  <a :class="`project-card tone-${tone}`" :href="href">
    <span aria-hidden="true" class="card-surface shader-tile" />
    <div class="card-content">
      <div class="card-heading">
        <h4 :class="name === 'fate' ? 'fate-name' : undefined">{{ name }}</h4>
        <span aria-hidden="true" class="external-arrow">↗</span>
      </div>
      <p>{{ description }}</p>
      <div class="card-footer">
        <span>{{ domain }}</span>
        <span class="project-type">{{ type }}</span>
      </div>
    </div>
  </a>
</template>
