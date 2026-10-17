'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

type Theme = 'light' | 'dark'

const storageKey = 'mentor.theme'

export const ThemeToggle = () => {
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light')

    const syncTheme = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== null) return
      if (event.newValue !== null && event.newValue !== 'light' && event.newValue !== 'dark') return

      const nextTheme = event.newValue === 'light' ? 'light' : 'dark'
      document.documentElement.classList.toggle('dark', nextTheme === 'dark')
      setTheme(nextTheme)
    }

    window.addEventListener('storage', syncTheme)
    return () => window.removeEventListener('storage', syncTheme)
  }, [])

  const toggleTheme = () => {
    const nextTheme = document.documentElement.classList.contains('dark') ? 'light' : 'dark'
    document.documentElement.classList.toggle('dark', nextTheme === 'dark')
    setTheme(nextTheme)

    try {
      localStorage.setItem(storageKey, nextTheme)
    } catch {
      // The current theme still works when browser storage is unavailable.
    }
  }

  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      {theme === 'dark' ? (
        <Sun size={17} aria-hidden="true" />
      ) : (
        <Moon size={17} aria-hidden="true" />
      )}
    </button>
  )
}
