// Single home for user-facing copy: the interface is Polish, the code is not.
export const messages = {
  appName: "Hubber",
  // Keyed by TanStack Query status so a status maps straight to its label.
  health: {
    pending: "Sprawdzam połączenie…",
    success: "Serwer działa",
    error: "Brak połączenia z serwerem",
  },
} as const;
