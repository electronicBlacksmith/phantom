import { useBootstrap } from "@/hooks/use-bootstrap";
import { ThemeToggle } from "./theme-toggle";

export function SidebarFooter() {
  const { data, cachedName, cachedGen } = useBootstrap();

  const agentName = data?.agent_name ?? cachedName ?? "Agent";
  const gen = data?.evolution_gen ?? cachedGen;

  return (
    <div className="border-t border-sidebar-border px-3 py-3">
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-sidebar-foreground">
            {agentName}
          </div>
          <div className="flex gap-2 text-xs text-sidebar-muted-foreground">
            {gen != null && gen > 0 && <span>Gen {gen}</span>}
          </div>
        </div>
        <ThemeToggle />
      </div>
    </div>
  );
}
