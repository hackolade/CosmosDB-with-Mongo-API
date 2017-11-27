const client = require('mongodb').MongoClient;

client.connect(
	'mongodb://c5408e91-0ee0-4-231-b9ee:JtHikMX4hrBKCdkVpI3XQD2CngI5VfwKwBHzEgHxkLtw4npFmhHFyMitvOoHEwMMTboLLrScb4HaukUQFe7RhA==@c5408e91-0ee0-4-231-b9ee.documents.azure.com:10255/?ssl=true&replicaSet=globaldb',{ssl: true}, 
	(err, con) => { 
		console.error(err);
		con.admin().listDatabases((err, dbs) => { 
			const db = con.db(dbs.databases[0].name); 
			db.collections().then(items => { 
				const col = items[1]; 
				items[1].find().limit(0).toArray((err, res) => console.log(res));
			});
		});
	}
);
