import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import '@/app/globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })

export const metadata: Metadata = {
  title: 'mentor — Find your voice at work',
  description:
    'Immersive, voice-first English practice for software engineers. Real workplace conversations, a personal AI coach, and a little more confidence every day.',
}

const themeBootstrap = `
  try {
    const theme = localStorage.getItem('mentor.theme')
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.classList.toggle('dark', theme === 'dark')
    }
  } catch {}
`

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className={`${geist.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  )
}
