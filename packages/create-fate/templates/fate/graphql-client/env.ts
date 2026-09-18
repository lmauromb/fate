import { defineEnv, url } from 'void/env';

export default defineEnv({
  VITE_GRAPHQL_LIVE_URL: url().optional(),
  VITE_GRAPHQL_URL: url().default('https://api.example.com/graphql'),
});
