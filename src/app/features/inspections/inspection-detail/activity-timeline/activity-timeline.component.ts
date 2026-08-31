import {ChangeDetectionStrategy, Component, input} from '@angular/core';
import {RouterLink} from '@angular/router';
import {AuditEvent} from '../../../../core/models/inspection.models';

@Component({selector:'app-activity-timeline',standalone:true,imports:[RouterLink],template:`<section><header><h2>Audit trail</h2><a routerLink="/audit-log">View all</a></header>@for(event of events().slice().reverse().slice(0,5);track event.id){<article><span>{{ initials(event.actor) }}</span><div><strong>{{ event.action }}</strong><small>{{ event.occurredAt }} @if(event.detail){<br>{{ event.detail }}}</small></div></article>}</section>`,styleUrl:'./activity-timeline.component.css',changeDetection:ChangeDetectionStrategy.OnPush})
export class ActivityTimelineComponent {
  readonly events=input.required<AuditEvent[]>();
  initials(actor: string): string { return actor.split(' ').map(part => part[0]).join('').slice(0, 2); }
}
