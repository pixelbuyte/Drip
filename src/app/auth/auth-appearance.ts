import { ThemeSupa } from '@supabase/auth-ui-shared';

// Supabase's Auth UI renders its own markup, so it gets themed through
// variables rather than classes. Values mirror the tokens in globals.css.
export const authAppearance = {
  theme: ThemeSupa,
  variables: {
    default: {
      colors: {
        brand: '#ff4b2e',
        brandAccent: '#e5401f',
        brandButtonText: '#201a17',
        defaultButtonBackground: '#2b2420',
        defaultButtonBackgroundHover: '#362e28',
        defaultButtonBorder: '#3a322c',
        defaultButtonText: '#fff9f2',
        dividerBackground: '#3a322c',
        inputBackground: '#2b2420',
        inputBorder: '#3a322c',
        inputBorderHover: '#4a403a',
        inputBorderFocus: '#ff4b2e',
        inputText: '#fff9f2',
        inputLabelText: '#a89d94',
        inputPlaceholder: '#7a6f66',
        messageText: '#a89d94',
        messageTextDanger: '#ff8a70',
        anchorTextColor: '#a89d94',
        anchorTextHoverColor: '#fff9f2',
      },
      radii: {
        borderRadiusButton: '10px',
        buttonBorderRadius: '10px',
        inputBorderRadius: '10px',
      },
      fonts: {
        bodyFontFamily: 'var(--font-hanken), ui-sans-serif, system-ui, sans-serif',
        buttonFontFamily: 'var(--font-hanken), ui-sans-serif, system-ui, sans-serif',
        inputFontFamily: 'var(--font-hanken), ui-sans-serif, system-ui, sans-serif',
        labelFontFamily: 'var(--font-hanken), ui-sans-serif, system-ui, sans-serif',
      },
    },
  },
};
