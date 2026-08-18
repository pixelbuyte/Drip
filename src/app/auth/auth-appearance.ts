import { ThemeSupa } from '@supabase/auth-ui-shared';

// Supabase's Auth UI renders its own markup, so it gets themed through
// variables rather than classes. Values mirror the bright cream/coral tokens
// in globals.css — this used to hardcode the old dark "Instrument" palette
// (dark inputs, acid-lime accents) left over from before the shopping pivot,
// which is why the login/signup pages read as a completely different, older
// product than everything around them.
export const authAppearance = {
  theme: ThemeSupa,
  variables: {
    default: {
      colors: {
        brand: '#ff4b2e',
        brandAccent: '#e5401f',
        brandButtonText: '#fff9f2',
        defaultButtonBackground: '#ffffff',
        defaultButtonBackgroundHover: '#fff9f2',
        defaultButtonBorder: 'rgba(32,26,23,0.12)',
        defaultButtonText: '#201a17',
        dividerBackground: 'rgba(32,26,23,0.08)',
        inputBackground: '#ffffff',
        inputBorder: 'rgba(32,26,23,0.12)',
        inputBorderHover: 'rgba(32,26,23,0.24)',
        inputBorderFocus: '#ff4b2e',
        inputText: '#201a17',
        inputLabelText: '#6e6259',
        inputPlaceholder: '#a89d94',
        messageText: '#6e6259',
        messageTextDanger: '#d92d0f',
        anchorTextColor: '#6e6259',
        anchorTextHoverColor: '#201a17',
      },
      radii: {
        borderRadiusButton: '999px',
        buttonBorderRadius: '999px',
        inputBorderRadius: '12px',
      },
      fonts: {
        bodyFontFamily: 'var(--font-hanken), ui-sans-serif, system-ui, sans-serif',
        buttonFontFamily: 'var(--font-hanken), ui-sans-serif, system-ui, sans-serif',
        inputFontFamily: 'var(--font-hanken), ui-sans-serif, system-ui, sans-serif',
        labelFontFamily: 'var(--font-hanken), ui-sans-serif, system-ui, sans-serif',
      },
      fontSizes: {
        baseButtonSize: '15px',
        baseInputSize: '15px',
        baseLabelSize: '13px',
      },
      space: {
        inputPadding: '12px 16px',
        buttonPadding: '12px 20px',
      },
    },
  },
};
