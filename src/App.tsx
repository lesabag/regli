import { useAuth } from './hooks/useAuth'
import AuthScreen from './components/AuthScreen'
import AdminDashboard from './screens/AdminDashboard'
import ClientDashboard from './screens/ClientDashboard'
import WalkerDashboard from './screens/WalkerDashboard'

export default function App() {
  const {
    session,
    profile,
    loading,
    authError,
    signIn,
    signUp,
    signOut,
  } = useAuth()

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100svh',
          display: 'grid',
          placeItems: 'center',
          background: '#F3F6FB',
          color: '#001A33',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        Loading...
      </div>
    )
  }

  if (!session) {
    return (
      <AuthScreen
        onSignIn={signIn}
        onSignUp={signUp}
        authError={authError}
      />
    )
  }

  if (!profile) {
    return (
      <div
        style={{
          minHeight: '100svh',
          display: 'grid',
          placeItems: 'center',
          background: '#F3F6FB',
          color: '#001A33',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        Setting up your profile...
      </div>
    )
  }

  if (profile.role === 'admin') {
    return <AdminDashboard profile={profile} onSignOut={signOut} />
  }

  if (profile.role === 'walker') {
    return <WalkerDashboard profile={profile} onSignOut={signOut} />
  }

  return <ClientDashboard profile={profile} onSignOut={signOut} />
}
