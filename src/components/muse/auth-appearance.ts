import type { ClerkProvider } from '@clerk/nextjs';
import type { ComponentProps } from 'react';

type ProviderProps = ComponentProps<typeof ClerkProvider>;
type AuthTheme = NonNullable<NonNullable<ProviderProps['appearance']>['signIn']>;

const signInAppearance: AuthTheme = {
  options: { socialButtonsVariant: 'blockButton', logoPlacement: 'none', unsafe_disableDevelopmentModeWarnings: true },
  variables: {
    colorPrimary: '#2e70d6', colorForeground: '#202124', colorMutedForeground: '#737a84',
    colorBackground: '#ffffff', colorInput: '#f6f7f8', borderRadius: '7px',
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', fontSize: '13px',
  },
  elements: {
    modalBackdrop: { backgroundColor: 'rgba(0, 0, 0, .2)', padding: '20px', alignItems: 'center' },
    modalContent: { margin: '0', width: '360px', maxWidth: '100%', maxHeight: 'calc(100dvh - 40px)' },
    modalCloseButton: { top: '12px', right: '12px', color: '#363a40' },
    rootBox: {
      width: '100%', maxWidth: '360px',
      '& .cl-footerAction': { padding: '0 !important', justifyContent: 'center', flexWrap: 'wrap' },
      '& .cl-footerActionLink': { whiteSpace: 'nowrap' },
      '& .cl-footerItem': { padding: '8px 0 !important' },
    },
    cardBox: { width: '100%', maxWidth: '100%', borderRadius: '10px', border: '1px solid #e6e8ec', boxShadow: '0 2px 5px #0002, 0 16px 60px #0000000a' },
    card: { width: '100%', padding: '38px 22px 24px', boxShadow: 'none', gap: '24px', borderRadius: '10px' },
    header: { gap: '16px' },
    headerTitle: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '9px', fontSize: '23px', fontWeight: 700, letterSpacing: '-.65px', '&::before': { content: '""', display: 'block', width: '27px', height: '27px', background: 'url(/icon.svg) center / contain no-repeat' } },
    headerSubtitle: { fontSize: '13px', lineHeight: '1.5', color: '#565c65', maxWidth: '260px', marginInline: 'auto' },
    socialButtons: { display: 'flex', flexDirection: 'column', gap: '8px' },
    socialButtonsBlockButton: { minHeight: '38px', borderRadius: '6px', boxShadow: 'none' },
    socialButtonsBlockButton__google: { background: '#2e70d6', color: '#fff', border: '1px solid #2e70d6', '&:hover': { background: '#2563c4', borderColor: '#2563c4' } },
    socialButtonsBlockButtonText__google: { color: '#fff', fontSize: '13px', fontWeight: 500 },
    socialButtonsBlockButton__apple: { display: 'none' },
    socialButtonsBlockButton__github: { display: 'none' },
    dividerLine: { background: '#e1e3e6' },
    dividerText: { fontSize: '12px', color: '#737a84' },
    formFieldLabel: { fontSize: '12px', fontWeight: 500 },
    formFieldInput: { minHeight: '38px', padding: '9px 12px', border: '1px solid #e6e8ec', background: '#f6f7f8', boxShadow: 'none', borderRadius: '6px', fontSize: '13px' },
    formButtonPrimary: { minHeight: '38px', background: '#f1f2f4', border: '1px solid #d9dce1', color: '#202124', fontSize: '13px', fontWeight: 500, boxShadow: 'none', borderRadius: '6px', '&:hover': { background: '#e9ebee' } },
    footer: { background: '#fff', backgroundImage: 'none', borderTop: '1px solid #eef0f2', padding: '16px 22px', gap: '16px' },
    footerActionText: { fontSize: '12px', color: '#737a84' },
    footerActionLink: { fontSize: '12px', fontWeight: 500 },
  },
};

export const authAppearance: ProviderProps['appearance'] = {
  options: { socialButtonsVariant: 'blockButton', unsafe_disableDevelopmentModeWarnings: true },
  variables: { colorPrimary: '#5277ee', borderRadius: '12px' },
  signIn: signInAppearance,
  signUp: signInAppearance,
};

export const authLocalization: ProviderProps['localization'] = {
  socialButtonsBlockButton: 'Sign in with {{provider|titleize}}',
  socialButtonsBlockButtonManyInView: 'Sign in with {{provider|titleize}}',
  signIn: { start: { title: 'Muze', subtitle: 'Sign in to your workspace.' } },
  signUp: { start: { title: 'Muze', subtitle: 'Create your account to get started.' } },
};
