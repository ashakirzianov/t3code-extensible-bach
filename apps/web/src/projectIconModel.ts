// Moved to `@t3tools/shared/projectIcon` so the server can resolve the same
// automatic icon for extensions; re-exported here to keep web imports stable.
export {
  PROJECT_ICON_NAMES,
  selectProjectIcon,
  type ProjectIconName,
  type ProjectIconSelection,
} from "@t3tools/shared/projectIcon";
