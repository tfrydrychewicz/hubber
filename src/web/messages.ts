// Single home for user-facing copy: the interface is Polish, the code is not.
export const messages = {
  appName: "Hubber",
  // Keyed by TanStack Query status so a status maps straight to its label.
  health: {
    pending: "Sprawdzam połączenie…",
    success: "Serwer działa",
    error: "Brak połączenia z serwerem",
  },
  workspace: {
    // The accessible name of the indicator; the two labels below are what is on screen.
    label: "Aktywny workspace",
    name: "Workspace",
    endpoint: "Endpoint",
    pending: "Sprawdzam workspace…",
    error: "Nie udało się odczytać workspace'u",
  },
} as const;
