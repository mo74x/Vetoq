export class VetoqApiCredentials {
  name = 'vetoqApi';
  displayName = 'Vetoq API';
  properties = [
    {
      displayName: 'API URL',
      name: 'apiUrl',
      type: 'string',
      default: 'https://api.vetoq.dev',
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
    },
  ];
}
