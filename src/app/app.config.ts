import {ApplicationConfig, LOCALE_ID, isDevMode} from '@angular/core';
import {registerLocaleData} from '@angular/common';
import localeEnAu from '@angular/common/locales/en-AU';
import {provideRouter, withComponentInputBinding, withInMemoryScrolling, withPreloading, PreloadAllModules} from '@angular/router';
import {provideServiceWorker} from '@angular/service-worker';
import {routes} from './app.routes';

registerLocaleData(localeEnAu);

export const appConfig: ApplicationConfig = {
  providers: [
    {provide: LOCALE_ID, useValue: 'en-AU'},
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({scrollPositionRestoration: 'top'}),
      withPreloading(PreloadAllModules),
    ),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
