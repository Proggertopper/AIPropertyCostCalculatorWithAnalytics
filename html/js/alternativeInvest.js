function calculateComparison() {
  const propertyInitial = +document.getElementById("propertyInitial").value;
  const propertyCashflow = +document.getElementById("propertyCashflow").value;
  const propertyGrowth = +document.getElementById("propertyGrowth").value / 100;

  const altReturn = +document.getElementById("altReturn").value / 100;
  const altContribution = +document.getElementById("altContribution").value;

  const years = +document.getElementById("years").value;

  // Недвижимость
  let propertyValue = propertyInitial;
  for (let i = 1; i <= years; i++) {
    propertyValue *= (1 + propertyGrowth);
    propertyValue += propertyCashflow;
  }

  // Альтернативные инвестиции
  let altValue = propertyInitial;
  for (let i = 1; i <= years; i++) {
    altValue = altValue * (1 + altReturn) + altContribution;
  }

  document.getElementById("propertyResult").textContent =
    propertyValue.toFixed(0) + " $";

  document.getElementById("alternativeResult").textContent =
    altValue.toFixed(0) + " $";

  const winner = document.getElementById("winner");

  if (propertyValue > altValue) {
    winner.textContent = "Недвижимость выгоднее 📈";
    winner.className = "winner property";
  } else {
    winner.textContent = "Альтернативные инвестиции выгоднее 📊";
    winner.className = "winner alternative";
  }
}