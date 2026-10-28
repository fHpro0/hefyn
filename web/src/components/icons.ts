import { BarChart3, Bell, CalendarClock, Blocks, Bot, Box, Calendar, Cpu, Database, FileText, Folder, Globe, HardDrive, Headset, KeyRound, Laptop, Lock, Mail, MessageSquare, PackageCheck, Palette, PenLine, Plug, Scale, Send, Settings, Shield, Sparkles, SquarePen, Store, User, Users, Wrench, Zap, Briefcase, Image, type LucideIcon } from 'lucide-react';

// Modules name lucide icons; only these are bundled (not the whole set). Unknown names fall back to Blocks.
const ICONS: Record<string, LucideIcon> = {
  BarChart3, ChartBar: BarChart3, Bell, CalendarClock, Blocks, Bot, Box, Calendar, Cpu, Database, FileText, Folder, Globe, HardDrive, Headset, KeyRound, Laptop, Lock, Mail, MessageSquare, PackageCheck, Palette, PenLine, Plug, Scale, Send, Settings, Shield, Sparkles, SquarePen, Store, User, Users, Wrench, Zap, Briefcase, Image,
};
/** Every icon the console bundles, for the icon picker. */
export const ALL_ICON_NAMES = Object.keys(ICONS).filter((n) => n !== 'ChartBar').sort();
export const ICON_NAMES = ['Headset','MessageSquare', 'PenLine', 'Sparkles', 'Briefcase', 'Scale', 'Bot', 'FileText', 'Mail', 'Globe', 'Database'];
// hasOwn: a name like `constructor` must not find Object.prototype members.
export const iconFor = (name?: string): LucideIcon => (name && Object.hasOwn(ICONS, name) ? ICONS[name]! : Blocks);
