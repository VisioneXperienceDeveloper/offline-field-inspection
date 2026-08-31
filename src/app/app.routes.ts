import {Routes} from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./layout/app-shell/app-shell.component').then(module => module.AppShellComponent),
    children: [
      {path: '', pathMatch: 'full', redirectTo: 'inspections'},
      {path: 'dashboard', title: 'Dashboard · FIELDNOTE', loadComponent: () => import('./features/dashboard/dashboard-page.component').then(module => module.DashboardPageComponent)},
      {path: 'inspections', title: 'Inspections · FIELDNOTE', loadComponent: () => import('./features/inspections/inspection-list/inspection-list-page.component').then(module => module.InspectionListPageComponent)},
      {path: 'inspections/:id', title: 'Inspection · FIELDNOTE', loadComponent: () => import('./features/inspections/inspection-detail/inspection-detail-page.component').then(module => module.InspectionDetailPageComponent)},
      {path: 'templates', title: 'Templates · FIELDNOTE', loadComponent: () => import('./features/templates/templates-page.component').then(module => module.TemplatesPageComponent)},
      {path: 'audit-log', title: 'Audit Log · FIELDNOTE', loadComponent: () => import('./features/audit/audit-page.component').then(module => module.AuditPageComponent)},
      {path: 'settings', title: 'Settings · FIELDNOTE', loadComponent: () => import('./features/settings/settings-page.component').then(module => module.SettingsPageComponent)},
      {path: 'help', title: 'Help · FIELDNOTE', loadComponent: () => import('./features/help/help-page.component').then(module => module.HelpPageComponent)},
    ],
  },
  {path: '**', redirectTo: 'inspections'},
];
