// Follows the system appearance; the coss tokens switch on the .dark class.
export function followSystemTheme(): void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (): void => {
    document.documentElement.classList.toggle("dark", query.matches);
  };
  apply();
  query.addEventListener("change", apply);
}
