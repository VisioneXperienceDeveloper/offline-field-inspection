import {ApplicationConfig} from '@angular/core';
import {provideRouter, withComponentInputBinding, withInMemoryScrolling, withPreloading, PreloadAllModules} from '@angular/router';
import {routes} from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({scrollPositionRestoration: 'top'}),
      withPreloading(PreloadAllModules),
    ),
  ],
};
