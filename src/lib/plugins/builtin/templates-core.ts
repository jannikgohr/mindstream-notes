/**
 * Bundled "Core Templates" plugin.
 *
 * A real, first-party manifest-only plugin that ships with the app and serves
 * as the reference implementation for the template slice. It contributes two
 * markdown templates, a settings subsection, and one app-local command — all
 * declaratively, with English + German strings. It requests only the two MVP
 * permissions and runs no code.
 *
 * This is deliberately data, not behaviour: everything here flows through the
 * same validation, registry, i18n and creation paths a third-party plugin
 * would, so exercising it exercises the whole system.
 */

import type { PluginManifest } from '../types';

export const TEMPLATES_CORE_MANIFEST: PluginManifest = {
  id: 'com.mindstream.templates.core',
  name: 'Core Templates',
  version: '1.0.0',
  runtime: 'manifest-only',
  permissions: ['templates.contribute', 'notes.create'],
  contributes: {
    i18n: {
      en: {
        'templates.meeting.name': 'Meeting notes',
        'templates.meeting.description':
          'Agenda, attendees, decisions, and follow-ups',
        'templates.daily.name': 'Daily note',
        'templates.daily.description':
          "A dated page for the day's notes and tasks",
        'settings.general.title': 'Core Templates',
        'settings.openOnCreate.label': 'Open new template notes',
        'settings.openOnCreate.description':
          'Open a note in the editor right after creating it from a template',
        'commands.newMeeting.label': 'New meeting notes'
      },
      de: {
        'templates.meeting.name': 'Besprechungsnotizen',
        'templates.meeting.description':
          'Agenda, Teilnehmer, Entscheidungen und Aufgaben',
        'templates.daily.name': 'Tagesnotiz',
        'templates.daily.description':
          'Eine datierte Seite für Notizen und Aufgaben des Tages',
        'settings.general.title': 'Basisvorlagen',
        'settings.openOnCreate.label': 'Neue Vorlagennotizen öffnen',
        'settings.openOnCreate.description':
          'Eine Notiz direkt nach dem Erstellen aus einer Vorlage im Editor öffnen',
        'commands.newMeeting.label': 'Neue Besprechungsnotizen'
      }
    },
    noteTemplates: [
      {
        id: 'meeting',
        labelKey: 'templates.meeting.name',
        descriptionKey: 'templates.meeting.description',
        noteKind: 'markdown',
        titleTemplate: 'Meeting — {{date}}',
        bodyTemplate: [
          '# Meeting — {{date}}',
          '',
          '## Attendees',
          '',
          '## Agenda',
          '',
          '## Decisions',
          '',
          '## Follow-ups',
          ''
        ].join('\n')
      },
      {
        id: 'daily',
        labelKey: 'templates.daily.name',
        descriptionKey: 'templates.daily.description',
        noteKind: 'markdown',
        titleTemplate: '{{date}}',
        bodyTemplate: [
          '# {{date}}',
          '',
          '## Notes',
          '',
          '## Tasks',
          '',
          '- [ ] ',
          ''
        ].join('\n')
      }
    ],
    settings: [
      {
        sectionId: 'general',
        titleKey: 'settings.general.title',
        settings: [
          {
            id: 'open-on-create',
            labelKey: 'settings.openOnCreate.label',
            descriptionKey: 'settings.openOnCreate.description',
            scope: 'D',
            type: 'toggle',
            default: true
          }
        ]
      }
    ],
    commands: [
      {
        id: 'new-meeting',
        labelKey: 'commands.newMeeting.label',
        // No default binding — app-local, the user assigns one in Hotkeys.
        defaultBinding: null,
        action: { type: 'createTemplateNote', templateId: 'meeting' }
      }
    ]
  }
};
