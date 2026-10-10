window.__ModuleLoader__.load({
  id: 'dsh-quota-plan',
  factory: function(require) {
    const React = require('react');
    return {
      name: 'quota-plan-client',
      inject: ['slots'],
      apply: function(ctx) {
        ctx.slots.inject('settings.section', function() {
          return ctx.slots.register({ name: 'settings.section', id: 'quota-plan', label: 'Plan 额度', order: 25 }, function() {
            return React.createElement('iframe', {
              src: new URL('_dsh/quota-plan/?embedded=1', document.baseURI).href,
              title: 'DSH Plan 使用额度',
              style: { width: '100%', height: '78vh', minHeight: 460, border: 0, borderRadius: 12 },
            });
          });
        });
      },
    };
  },
});
