import { useState } from 'react'
import type { AppRole } from '../hooks/useAuth'

interface AuthScreenProps {
  onSignIn: (args: { email: string; password: string }) => Promise<{ ok: boolean }>
  onSignUp: (args: {
    email: string
    password: string
    fullName: string
    role: AppRole
  }) => Promise<{ ok: boolean }>
  authError?: string | null
}

export default function AuthScreen({
  onSignIn,
  onSignUp,
  authError,
}: AuthScreenProps) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<AppRole>('client')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (!email || !password) return
    if (mode === 'signup' && !fullName) return

    setSubmitting(true)

    if (mode === 'signin') {
      await onSignIn({ email, password })
    } else {
      await onSignUp({
        email,
        password,
        fullName,
        role,
      })
    }

    setSubmitting(false)
  }

  return (
    <div className="min-h-screen bg-[#F7F7F8] flex items-center justify-center px-5">
      <div className="w-full max-w-md rounded-[28px] bg-white p-6 shadow-[0_12px_32px_rgba(0,0,0,0.08)]">
        <h1 className="text-3xl font-bold text-[#001A33]">Regli</h1>
        <p className="mt-2 text-sm text-gray-500">
          {mode === 'signin' ? 'Sign in to continue' : 'Create your account'}
        </p>

        <div className="mt-5 flex gap-2 rounded-2xl bg-gray-100 p-1">
          <button
            type="button"
            onClick={() => setMode('signin')}
            className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold ${
              mode === 'signin' ? 'bg-white text-[#001A33]' : 'text-gray-500'
            }`}
          >
            Sign in
          </button>

          <button
            type="button"
            onClick={() => setMode('signup')}
            className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold ${
              mode === 'signup' ? 'bg-white text-[#001A33]' : 'text-gray-500'
            }`}
          >
            Sign up
          </button>
        </div>

        {mode === 'signup' && (
          <>
            <div className="mt-5">
              <label className="mb-2 block text-sm font-semibold text-[#001A33]">
                Full name
              </label>
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-2xl border border-gray-200 px-4 py-3 text-sm outline-none"
                placeholder="Your full name"
              />
            </div>

            <div className="mt-4">
              <label className="mb-2 block text-sm font-semibold text-[#001A33]">
                Role
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as AppRole)}
                className="w-full rounded-2xl border border-gray-200 px-4 py-3 text-sm outline-none"
              >
                <option value="client">Client</option>
                <option value="walker">Walker</option>
              </select>
            </div>
          </>
        )}

        <div className="mt-4">
          <label className="mb-2 block text-sm font-semibold text-[#001A33]">
            Email
          </label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-2xl border border-gray-200 px-4 py-3 text-sm outline-none"
            placeholder="name@example.com"
            type="email"
          />
        </div>

        <div className="mt-4">
          <label className="mb-2 block text-sm font-semibold text-[#001A33]">
            Password
          </label>
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-2xl border border-gray-200 px-4 py-3 text-sm outline-none"
            placeholder="Password"
            type="password"
          />
        </div>

        {authError && (
          <div className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">
            {authError}
          </div>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className={`mt-5 w-full rounded-2xl px-4 py-3 text-sm font-semibold ${
            submitting
              ? 'cursor-not-allowed bg-gray-200 text-gray-500'
              : 'bg-[#001A33] text-white'
          }`}
        >
          {submitting
            ? 'Please wait...'
            : mode === 'signin'
            ? 'Sign in'
            : 'Create account'}
        </button>
      </div>
    </div>
  )
}
