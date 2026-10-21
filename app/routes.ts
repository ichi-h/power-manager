import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/dashboard.tsx"),
  route("healthz", "routes/healthz.tsx"),
  route("api/status", "routes/api.status.tsx"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
