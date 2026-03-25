import { useRef, useEffect } from 'react'
import mapboxgl from 'mapbox-gl'

import 'mapbox-gl/dist/mapbox-gl.css';

import './App.css'

function App() {

  const mapRef = useRef<mapboxgl.Map | null>(null)
  const mapContainerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN
    mapRef.current = new mapboxgl.Map({
      container: mapContainerRef.current!,
    });

    mapRef.current.on('load', () => {
      const map = mapRef.current!;

      map.addSource('flightmap', {
        type: 'geojson',
        data: 'https://raw.githubusercontent.com/niehaus1301/flightmap/main/generated/flightmap.geojson',
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
        type: 'circle',
        source: 'flightmap',
        filter: ['==', ['get', 'featureType'], 'airport'],
        paint: {
          'circle-radius': 4,
          'circle-color': '#e63946',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1,
        },
      });
    });

    return () => {
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