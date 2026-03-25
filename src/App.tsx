import { useRef, useEffect } from 'react'
import mapboxgl from 'mapbox-gl'

import 'mapbox-gl/dist/mapbox-gl.css';

import AirportMarkerSvg from './assets/airportMarker.svg'
import './App.css'

function App() {

  const mapRef = useRef<mapboxgl.Map | null>(null)
  const mapContainerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN
    mapRef.current = new mapboxgl.Map({
      container: mapContainerRef.current!,
      style: import.meta.env.VITE_MAPBOX_STYLE,
    });

    const handleResize = () => mapRef.current?.resize();
    window.addEventListener('resize', handleResize);

    mapRef.current.on('load', () => {
      const map = mapRef.current!;

      requestAnimationFrame(() => {
        map.resize();
      });

      const img = new Image(150, 150);
      img.onload = () => map.addImage('marker', img);
      img.src = AirportMarkerSvg;

      map.addSource('flightmap', {
        type: 'geojson',
        data: `${import.meta.env.BASE_URL}flightmap.geojson`,
      });

      map.addLayer({
        id: 'routes',
        type: 'line',
        source: 'flightmap',
        filter: ['==', ['get', 'featureType'], 'route'],
        paint: {
          'line-color': '#e63946',
          'line-width': 1.5,
          'line-opacity': 0.6,
        },
      });

      map.addLayer({
        id: 'airports',
        type: 'symbol',
        source: 'flightmap',
        filter: ['==', ['get', 'featureType'], 'airport'],
        layout: {
          'icon-image': 'marker',
          'icon-size': 0.3,
          'icon-anchor': 'bottom',
          'icon-allow-overlap': true,
          'text-field': ['get', 'iata'],
          'text-anchor': 'top',
        },
      });
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      mapRef.current?.remove()
    }
  }, [])

  return (
    <>
      <div id='map-container' ref={mapContainerRef}/>
    </>
  )
}

export default App