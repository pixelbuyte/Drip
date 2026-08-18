import { ThemeSupa } from '@supabase/auth-ui-shared';

// Supabase's Auth UI renders its own markup, so it gets themed through
// variables rather than classes. Values mirror the tokens in globals.css.
export const authAppearance = {
  theme: ThemeSupa,
  variables: {
    default: {
      colors: {
        brand: '#d8ff3e',
        brandAccent: '#c4eb32',
        brandButtonText: '#0b0b0c',
        defaultButtonBackground: '#141417',
        defaultButtonBackgroundHover: '#1c1c21',
        defaultButtonBorder: '#26262b',
        defaultButtonText: '#f5f2ea',
        dividerBackground: '#26262b',
        inputBackground: '#141417',
        inputBorder: '#26262b',
        inputBorderHover: '#3a3a42',
        inputBorderFocus: '#d8ff3e',
        inputText: '#f5f2ea',
        inputLabelText: '#8a8880',
        inputPlaceholder: '#56554f',
        messageText: '#8a8880',
        messageTextDanger: '#ff4a26',
        anchorTextColor: '#8a8880',
        anchorTextHoverColor: '#f5f2ea',
      },
      radii: {
        borderRadiusButton: '10px',
        buttonBorderRadius: '10px',
        inputBorderRadius: '10px',
      },
      fonts: {
        bodyFontFamily: 'var(--font-instrument), ui-sans-serif, system-ui, sans-serif',
        buttonFontFamily: 'var(--font-instrument), ui-sans-serif, system-ui, sans-serif',
        inputFontFamily: 'var(--font-instrument), ui-sans-serif, system-ui, sans-serif',
        labelFontFamily: 'var(--font-instrument), ui-sans-serif, system-ui, sans-serif',
      },
    },
  },
};
