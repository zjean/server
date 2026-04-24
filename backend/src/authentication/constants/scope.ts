export enum AUTH_SCOPE {
  WEBDAV = 'webdav',
  CLIENT = 'client',
  // Nextcloud-compatible mobile clients (iOS / Android). Credentials are
  // minted by the custom-mobile-compat login-v2 flow and restricted to the
  // NC-compat endpoints; see applications/custom-mobile-compat/.
  MOBILE_NC = 'mobile_nc'
}
