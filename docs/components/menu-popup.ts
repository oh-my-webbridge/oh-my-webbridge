/** The popup surface and radio rows shared by the language and theme menus. */
export const menuPositioner = "isolate z-50 outline-none";
export const menuPopup =
  "min-w-40 origin-(--transform-origin) rounded-(--radius-card) border bg-fd-popover p-1 text-fd-popover-foreground shadow-(--shadow-overlay) outline-none data-open:animate-fd-popover-in data-closed:animate-fd-popover-out";
export const menuItem =
  "relative flex cursor-default items-center gap-2.5 rounded-(--radius) py-1.5 pr-8 pl-2 text-sm select-none data-highlighted:bg-fd-accent data-highlighted:text-fd-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0";
