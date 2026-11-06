import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  CheckSquare,
  ClipboardList,
  Database,
  FileCheck,
  Folder,
  History,
  Home,
  MessageSquare,
  Users,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Today", icon: Home },
  { href: "/commitments", label: "Commitments", icon: CheckSquare },
  { href: "/timeline", label: "Timeline", icon: History },
  { href: "/meetings", label: "Meetings", icon: Users },
  { href: "/standups", label: "Standups", icon: ClipboardList },
  { href: "/projects", label: "Projects", icon: Folder },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/review", label: "Review", icon: FileCheck },
  { href: "/db", label: "Database", icon: Database },
  { href: "/chat", label: "Chat", icon: MessageSquare },
];
