const admin = require('firebase-admin');

// The SDK will automatically discover the project ID and credentials
admin.initializeApp();

const db = admin.firestore();

const competitions = [
  {
    title: '£1k Giveaway',
    prizeDescription: 'A £1,000 cash prize. Sent straight to your bank account.',
    prizeImage: 'https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1470&q=80',
    status: 'live',
    endDate: admin.firestore.Timestamp.fromDate(new Date(new Date().setDate(new Date().getDate() + 14))), // 14 days from now
    ticketsSold: 0,
    totalTickets: 1500,
    cashAlternative: 1000,
    skillQuestion: {
      text: 'What is the capital city of the United Kingdom?',
      answers: ['London', 'Paris', 'Dublin'],
      correctAnswer: 'London'
    },
    ticketTiers: [{ amount: 1, price: 1.00 }],
    userEntryLimit: 100,
    fallbackClause: { type: 'percent', value: 70 },
    instantWinsConfig: { enabled: false },
    competitionType: 'cash',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  },
  {
    title: '£5k Giveaway',
    prizeDescription: 'A £5,000 cash prize. Sent straight to your bank account.',
    prizeImage: 'https://images.unsplash.com/photo-1580601925187-96c2b83c5553?ixlib=rb-4.0.3&ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&auto=format&fit=crop&w=1470&q=80',
    status: 'live',
    endDate: admin.firestore.Timestamp.fromDate(new Date(new Date().setDate(new Date().getDate() + 30))), // 30 days from now
    ticketsSold: 0,
    totalTickets: 7000,
    cashAlternative: 5000,
    skillQuestion: {
      text: 'Which of these is a prime number?',
      answers: ['10', '11', '12'],
      correctAnswer: '11'
    },
    ticketTiers: [{ amount: 1, price: 2.00 }],
    userEntryLimit: 100,
    fallbackClause: { type: 'percent', value: 70 },
    instantWinsConfig: { enabled: false },
    competitionType: 'cash',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }
];

const addCompetitions = async () => {
  const competitionCollection = db.collection('competitions');
  console.log('Adding competitions to Firestore...');
  for (const comp of competitions) {
    try {
      const docRef = await competitionCollection.add(comp);
      console.log(`Successfully added competition: "${comp.title}" with ID: ${docRef.id}`);
    } catch (error) {
      console.error(`Error adding competition "${comp.title}":`, error);
    }
  }
  console.log('Finished adding competitions.');
};

addCompetitions();
