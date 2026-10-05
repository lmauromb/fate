<script setup lang="ts">
import { useData } from 'vitepress';
import { VPNavBarSearch } from 'vitepress/theme-without-fonts';

const { frontmatter } = useData();
</script>

<template>
  <VPNavBarSearch v-if="frontmatter.layout !== 'home'" />
</template>
